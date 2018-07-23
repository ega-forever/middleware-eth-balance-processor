/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

require('dotenv/config');

const config = require('../config'),
  mongoose = require('mongoose'),
  erc20tokenDefinition = require('../contracts/TokenContract.json'),
  Promise = require('bluebird');

mongoose.Promise = Promise;
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri);
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});

const providerService = require('../services/providerService'),
  expect = require('chai').expect,
  models = require('../models'),
  amqp = require('amqplib'),
  ctx = {
    accounts: [],
    amqp: {}
  };


describe('core/balance processor', function () {

  before(async () => {
    models.init();
    ctx.amqp.instance = await amqp.connect(config.rabbit.url);
    ctx.amqp.channel = await ctx.amqp.instance.createChannel();

    await providerService.setRabbitmqChannel(ctx.amqp.channel, config.rabbit.serviceName);
    ctx.web3 = await providerService.get();
    await models.accountModel.remove();
  });

  after(async () => {
    ctx.web3.currentProvider.connection.end();
    return await mongoose.disconnect();
  });

  it('add account (if not exist) to mongo', async () => {
    ctx.accounts = await Promise.promisify(ctx.web3.eth.getAccounts)();
    await new models.accountModel({address: ctx.accounts[0]}).save();
  });

  it('send some eth and validate balance changes', async () => {
    ctx.hash = await Promise.promisify(ctx.web3.eth.sendTransaction)({
      from: ctx.accounts[0],
      to: ctx.accounts[1],
      value: 100
    });

    expect(ctx.hash).to.be.string;


    await ctx.amqp.channel.assertExchange('events', 'topic', {durable: false});
    await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test.balance`);
    await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test.balance`, 'events', `${config.rabbit.serviceName}_balance.*`);


    return await new Promise(res =>
      ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test.balance`, res, {noAck: true})
    );


  });

  it('refresh account in mongo', async () => {
    await models.accountModel.remove();
    await new models.accountModel({address: ctx.accounts[0]}).save();
  });

  it('send message about new account and check this balance', async () => {
    let account = await models.accountModel.findOne({address: ctx.accounts[0]});
    expect(account.balance.toNumber()).to.be.equal(0);

    await ctx.amqp.channel.assertExchange('internal', 'topic', {durable: false});
    await ctx.amqp.channel.publish('internal', `${config.rabbit.serviceName}_user.created`,
      new Buffer(JSON.stringify({
        address: ctx.accounts[0]
      }))
    );
    await Promise.delay(10000);
    account = await models.accountModel.findOne({address: ctx.accounts[0]});

    expect(account.balance.toNumber()).to.be.not.equal(0);
  });


  it('transfer: should transfer 100000 from creator to account[1]', async () => {
    let balance = [];

    const Erc20Contract = web3.eth.contract(erc20tokenDefinition.abi);

    const ERC20Token = await new Promise((res, rej) =>
      Erc20Contract.new({from: ctx.accounts[0], gas: 1000000}, (err, data) => err ? rej(err) : res(data))
    );

    const transfer = await new Promise((res, rej) =>
      ERC20Token.transfer(ctx.accounts[1], 100000, {from: ctx.accounts[0]}, (err, result) => err ? rej(err) : res(result))
    );

    await Promise.delay(5000);
    balance[0] = await TC.balanceOf.call(accounts[0]);
    balance[1] = await TC.balanceOf.call(accounts[1]);

    expect(balance[0].toNumber()).to.equal(900000);
    expect(balance[1].toNumber()).to.equal(100000);
  });


});
