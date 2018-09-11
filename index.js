/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

/**
 * Middleware service for handling user balance.
 * Update balances for accounts, which addresses were specified
 * in received transactions from blockParser via amqp
 *
 * @module Chronobank/eth-balance-processor
 * @requires config
 * @requires models/accountModel
 */

const config = require('./config'),
  mongoose = require('mongoose'),
  Promise = require('bluebird'),
  models = require('./models'),
  _ = require('lodash'),
  providerService = require('./services/providerService'),
  bunyan = require('bunyan'),
  log = bunyan.createLogger({name: 'core.balanceProcessor', level: config.logs.level}),
  getUpdatedBalance = require('./utils/balance/getUpdatedBalance'),
  amqp = require('amqplib');

mongoose.Promise = Promise;
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri, {useMongoClient: true});

const TX_QUEUE = `${config.rabbit.serviceName}_transaction`;

let init = async () => {

  models.init();

  mongoose.connection.on('disconnected', () => {
    throw new Error('mongo disconnected!');
  });

  let conn = await amqp.connect(config.rabbit.url);

  let channel = await conn.createChannel();

  channel.on('close', () => {
    throw new Error('rabbitmq process has finished!');
  });


  await channel.assertExchange('events', 'topic', {durable: false});
  await channel.assertExchange('internal', 'topic', {durable: false});


  await channel.assertQueue(`${config.rabbit.serviceName}.balance_processor`);
  await channel.bindQueue(`${config.rabbit.serviceName}.balance_processor`, 'events', `${TX_QUEUE}.*`);
  await channel.bindQueue(`${config.rabbit.serviceName}.balance_processor`, 'internal', `${config.rabbit.serviceName}_user.created`);

  await providerService.setRabbitmqChannel(channel, config.rabbit.serviceName);


  channel.prefetch(2);

  channel.consume(`${config.rabbit.serviceName}.balance_processor`, async (data) => {
    try {
      let parsedData = JSON.parse(data.content.toString());
      const addr = data.fields.routingKey.slice(TX_QUEUE.length + 1) || parsedData.address;

      let account = await models.accountModel.findOne({address: addr});

      if (!account)
        return channel.ack(data);

      const balances = await getUpdatedBalance(addr, parsedData.hash ? parsedData : null);

      account.balance = balances.balance;

      if (!_.isEmpty(balances.tokens)) {
        if (_.isObject(account.erc20token) || !_.isArray(account.erc20token))
          account.erc20token = [];

        for (let token of balances.tokens){
          _.pullAllBy(account.erc20token, token, 'address');

          if(parseInt(token.balance) === 0)
            continue;

          account.erc20token.push(token);
        }

        account.markModified('erc20token');
      }

      account.save();

      let message = {
        address: account.address,
        balance: account.balance,
        erc20token: account.erc20token,
        tx: parsedData.hash ? parsedData : null
      };

      log.info(`balance updated for ${account.address}`);
      await channel.publish('events', `${config.rabbit.serviceName}_balance.${account.address}`, new Buffer(JSON.stringify(message)));

    } catch (e) {
      log.error(e);
    }

    channel.ack(data);
  });
};

module.exports = init().catch(err => {
  log.error(err);
  process.exit(0);
});
