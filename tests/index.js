/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

require('dotenv/config');
process.env.LOG_LEVEL = 'error';

const config = require('../config'),
  models = require('../models'),
  spawn = require('child_process').spawn,
  Web3 = require('web3'),
  net = require('net'),
  fuzzTests = require('./fuzz'),
  performanceTests = require('./performance'),
  featuresTests = require('./features'),
  blockTests = require('./blocks'),
  Promise = require('bluebird'),
  mongoose = require('mongoose'),
  providerService = require('../services/providerService'),
  amqp = require('amqplib'),
  ctx = {};

mongoose.Promise = Promise;
mongoose.connect(config.mongo.data.uri, {useMongoClient: true});
mongoose.accounts = mongoose.createConnection(config.mongo.accounts.uri, {useMongoClient: true});


describe('core/balanceProcessor', function () {

  before(async () => {
    models.init();

    ctx.nodePid = spawn('node', ['--max_old_space_size=4096', 'tests/utils/node/ipcConverter.js'], {
      env: process.env,
      stdio: 'ignore'
    });
    await Promise.delay(5000);
    ctx.nodePid.on('exit', function () {
      process.exit(1);
    });

    const provider = /http:\/\//.test(config.web3.providers[0]) ?
      new Web3.providers.HttpProvider(config.web3.providers[0]) :
      new Web3.providers.IpcProvider(`${/^win/.test(process.platform) ? '\\\\.\\pipe\\' : ''}${config.web3.providers[0]}`, net);

    ctx.web3 = new Web3(provider);
    ctx.accounts = await Promise.promisify(ctx.web3.eth.getAccounts)();


    ctx.amqp = {};
    ctx.amqp.instance = await amqp.connect(config.rabbit.url);
    ctx.amqp.channel = await ctx.amqp.instance.createChannel();
    await ctx.amqp.channel.assertExchange('events', 'topic', {durable: false});
    await ctx.amqp.channel.assertExchange('internal', 'topic', {durable: false});
    await ctx.amqp.channel.assertQueue(`${config.rabbit.serviceName}_current_provider.get`, {durable: false});
    await ctx.amqp.channel.bindQueue(`${config.rabbit.serviceName}_current_provider.get`, 'internal', `${config.rabbit.serviceName}_current_provider.get`);

    ctx.amqp.channel.consume(`${config.rabbit.serviceName}_current_provider.get`, async () => {
      ctx.amqp.channel.publish('internal', `${config.rabbit.serviceName}_current_provider.set`, new Buffer(JSON.stringify({index: 0})));
    }, {noAck: true, autoDelete: true});

    await providerService.setRabbitmqChannel(ctx.amqp.channel, config.rabbit.serviceName);

    ctx.checkerPid = spawn('node', ['tests/utils/proxyChecker.js'], {
      env: process.env, stdio: 'ignore'
    });
    await Promise.delay(5000);
  });

  after(async () => {
    mongoose.disconnect();
    mongoose.accounts.close();
    await ctx.amqp.instance.close();
    await ctx.checkerPid.kill();
  });


  describe('block', () => blockTests(ctx));


  describe('fuzz', () => fuzzTests(ctx));

  describe('features', () => featuresTests(ctx));
  describe('performance', () => performanceTests(ctx));

});
