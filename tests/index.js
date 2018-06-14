/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

require('dotenv/config');

const config = require('../config'),
  mongoose = require('mongoose'),
  Promise = require('bluebird');

mongoose.Promise = Promise;
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri);
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});

const awaitLastBlock = require('./helpers/awaitLastBlock'),
  net = require('net'),
  path = require('path'),
  Web3 = require('web3'),
  web3 = new Web3(),
  expect = require('chai').expect,
  WebSocket = require('ws'),
  accountModel = require('../models/accountModel'),
  amqp = require('amqplib'),
  Stomp = require('webstomp-client'),
  ctx = {};

let accounts;

describe('core/balance processor', function () {

  before(async () => {
    await accountModel.remove();
    let provider = new Web3.providers.IpcProvider(config.web3.uri, net);
    web3.setProvider(provider);

    return await awaitLastBlock(web3);
  });

  after(async () => {
    web3.currentProvider.connection.end();
    return await mongoose.disconnect();
  });

  it('add account (if not exist) to mongo', async () => {
    accounts = await Promise.promisify(web3.eth.getAccounts)();
    try {
      await new accountModel({address: accounts[0]}).save();
    } catch (e) {
    }
  });

  it('send some eth and validate balance changes', async () => {
    ctx.hash = await Promise.promisify(web3.eth.sendTransaction)({
      from: accounts[0],
      to: accounts[1],
      value: 100
    });

    expect(ctx.hash).to.be.string;

    await Promise.all([
      (async () => {

        let amqpInstance = await amqp.connect(config.rabbit.url);
        let channel = await amqpInstance.createChannel();
        try {
          await channel.assertExchange('events', 'topic', {durable: false});
          await channel.assertQueue(`app_${config.rabbit.serviceName}_test.balance`);
          await channel.bindQueue(`app_${config.rabbit.serviceName}_test.balance`, 'events', `${config.rabbit.serviceName}_balance.*`);
        } catch (e) {
          channel = await amqpInstance.createChannel();
        }

        return await new Promise(res =>
          channel.consume(`app_${config.rabbit.serviceName}_test.balance`, res, {noAck: true})
        )

      })(),
      (async () => {
        let ws = new WebSocket('ws://localhost:15674/ws');
        let client = Stomp.over(ws, {heartbeat: false, debug: false});
        return await new Promise(res =>
          client.connect('guest', 'guest', () => {
            client.subscribe(`/exchange/events/${config.rabbit.serviceName}_balance.*`, res)
          })
        );
      })()
    ]);

  });

  it('refresh account in mongo', async () => {
      await accountModel.remove();
      await new accountModel({address: accounts[0]}).save();
  });

  it('send message about new account and check this balance', async () => {
    let account = await accountModel.findOne({address: accounts[0]});
    expect(account.balance.confirmed.toNumber()).to.be.equal(0);
    expect(account.balance.unconfirmed.toNumber()).to.be.equal(0);
    expect(account.balance.vested.toNumber()).to.be.equal(0);

    const channel = await amqpInstance.createChannel(); 
    await channel.assertExchange('internal', 'topic', {durable: false});
    await channel.publish('internal', `${config.rabbit.serviceName}_user.created`, 
      new Buffer(JSON.stringify({
        address: accounts[0]
      }))
    );
    await Promise.delay(4000);
    account = await accountModel.findOne({address: accounts[0]});

    expect(account.balance.confirmed.toNumber()).to.be.not.equal(0);
    expect(account.balance.unconfirmed.toNumber()).to.be.not.equal(0);
    expect(account.balance.vested.toNumber()).to.be.not.equal(0);
    
  });

});
