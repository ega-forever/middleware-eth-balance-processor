const config = require('./config'),
  mongoose = require('mongoose'),
  accountModel = require('./models/accountModel'),
  Web3 = require('web3'),
  net = require('net'),
  bunyan = require('bunyan'),
  Promise = require('bluebird'),
  log = bunyan.createLogger({name: 'core.balanceProcessor'}),
  amqp = require('amqplib');

/**
 * @module entry point
 * @description update balances for accounts, which addresses were specified
 * in received transactions from blockParser via amqp
 */
mongoose.Promise = Promise;
mongoose.connect(config.mongo.uri, {useMongoClient: true});

let init = async () => {
  let conn = await amqp.connect(config.rabbit.url);
  let channel = await conn.createChannel();

  let provider = new Web3.providers.IpcProvider(config.web3.uri, net);
  const web3 = new Web3();
  web3.setProvider(provider);

  try {
    await channel.assertExchange('events', 'topic', {durable: false});
    await channel.assertQueue('app_eth.balance_processor');
    await channel.bindQueue('app_eth.balance_processor', 'events', 'eth_transaction.*');
  } catch (e) {
    log.error(e);
    channel = await conn.createChannel();
  }

  channel.consume('app_eth.balance_processor', async (data) => {
    try {
      let blockHash = JSON.parse(data.content.toString());

      let tx = await Promise.promisify(web3.eth.getTransaction)(blockHash);

      let accounts = tx ? await accountModel.find({address: {$in: [tx.to, tx.from]}}) : [];

      for (let account of accounts) {
        let balance = await Promise.promisify(web3.eth.getBalance)(account.address);
        await accountModel.update({address: account.address}, {$set: {balance: balance}})
          .catch(() => {
          });

        await  channel.publish('events', `eth_balance.${account.address}`, new Buffer(JSON.stringify({
          address: account.address,
          balance: balance,
          tx: tx
        })));
      }

    } catch (e) {
      log.error(e);
    }

    channel.ack(data);

  });

};

module.exports = init();
