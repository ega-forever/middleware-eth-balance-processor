/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const models = require('../../models'),
  config = require('../../config'),
  _ = require('lodash'),
  expect = require('chai').expect,
  Promise = require('bluebird'),
  spawn = require('child_process').spawn;

module.exports = (ctx) => {

  before(async () => {
    await models.txModel.remove({});
    await models.txLogModel.remove({});
    await models.accountModel.remove({});
    await ctx.amqp.channel.deleteQueue(`${config.rabbit.serviceName}.balance_processor`);

    ctx.balanceProcessorPid = spawn('node', ['index.js'], {env: process.env, stdio: 'inherit'});
    await Promise.delay(5000);

    for (let address of _.take(ctx.accounts, 2))
      await models.accountModel.create({
        address: address,
        balance: 0,
        erc20token: {},
        isActive: true
      });
  });



  it('validate balance processor update balance ability', async () => {


    let txHash = await Promise.promisify(ctx.web3.eth.sendTransaction)({
      from: ctx.accounts[0],
      to: ctx.accounts[1],
      value: 1000
    });
    let tx = await Promise.promisify(ctx.web3.eth.getTransaction)(txHash);

    await ctx.amqp.channel.assertQueue(`app_${config.rabbit.serviceName}_test_fuzz.balance`);
    await ctx.amqp.channel.bindQueue(`app_${config.rabbit.serviceName}_test_fuzz.balance`, 'events', `${config.rabbit.serviceName}_balance.${ctx.accounts[0]}`);
    await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[0]}`, new Buffer(JSON.stringify(tx)));

    await new Promise((res) => {
      ctx.amqp.channel.consume(`app_${config.rabbit.serviceName}_test_fuzz.balance`, async data => {

        if (!data)
          return;

        const message = JSON.parse(data.content.toString());

        if (message.address === ctx.accounts[0]) {
          await ctx.amqp.channel.deleteQueue(`app_${config.rabbit.serviceName}_test_fuzz.balance`);
          res();
        }

      });
    });

    let account = await models.accountModel.findOne({address: ctx.accounts[0]});
    expect(parseInt(account.balance)).to.be.above(0);
  });


  it('kill balance processor', async () => {
    ctx.balanceProcessorPid.kill();
  });

  it('send notification and restart balance processor', async () => {
    let account = await models.accountModel.findOne({address: ctx.accounts[0]});

    let txHash = await Promise.promisify(ctx.web3.eth.sendTransaction)({
      from: ctx.accounts[0],
      to: ctx.accounts[1],
      value: 1000
    });
    let tx = await Promise.promisify(ctx.web3.eth.getTransaction)(txHash);

    await ctx.amqp.channel.publish('events', `${config.rabbit.serviceName}_transaction.${ctx.accounts[0]}`, new Buffer(JSON.stringify(tx)));


    ctx.balanceProcessorPid = spawn('node', ['index.js'], {env: process.env, stdio: 'inherit'});
    await Promise.delay(20000);
    let accountUpdated = await models.accountModel.findOne({address: ctx.accounts[0]});
    expect(account.balance).to.not.eq(accountUpdated.balance);
  });


  after(async () => {
    ctx.balanceProcessorPid.kill();
  });


};
