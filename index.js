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
  let conn = await amqp.connect(config.rabbit.url)
    .catch(() => {
      log.error('rabbitmq is not available!');
      process.exit(0);
    });

  let channel = await conn.createChannel();

  channel.on('close', () => {
    log.error('rabbitmq process has finished!');
    process.exit(0);
  });

  let provider = new Web3.providers.IpcProvider(config.web3.uri, net);
  const web3 = new Web3();
  web3.setProvider(provider);

  web3.currentProvider.connection.on('end', () => {
    log.error('ipc process has finished!');
    process.exit(0);
  });

  web3.currentProvider.connection.on('error', () => {
    log.error('ipc process has finished!');
    process.exit(0);
  });

  await channel.assertExchange('events', 'topic', {durable: false});
  await channel.assertQueue(`app_${config.rabbit.serviceName}.balance_processor`);
  await channel.bindQueue(`app_${config.rabbit.serviceName}.balance_processor`, 'events', `${config.rabbit.serviceName}_transaction.*`);
  channel.prefetch(2);

  channel.consume(`app_${config.rabbit.serviceName}.balance_processor`, async (data) => {
    try {
      let block = JSON.parse(data.content.toString());
      let tx = await Promise.promisify(web3.eth.getTransaction)(block.hash || '');

      let accounts = tx ? await accountModel.find({address: {$in: [tx.to, tx.from]}}) : [];

      for (let account of accounts) {
        let balance = await Promise.promisify(web3.eth.getBalance)(account.address);
        await accountModel.update({address: account.address}, {$set: {balance: balance}})
          .catch(() => {
          });

        await  channel.publish('events', `${config.rabbit.serviceName}_balance.${account.address}`, new Buffer(JSON.stringify({
          address: account.address,
          balance: balance,
          tx: tx
        })));
      }

    } catch (e) {
      console.log(e)
      log.error(e);
    }

    channel.ack(data);

  });

};

module.exports = init();
