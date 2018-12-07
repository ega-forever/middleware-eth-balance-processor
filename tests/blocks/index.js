/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const models = require('../../models'),
  _ = require('lodash'),
  erc20token = require('../../contracts/TokenContract.json'),
  crypto = require('crypto'),
  getUpdatedBalance = require('../../utils/balance/getUpdatedBalance'),
  transferEventToQueryConverter = require('../../utils/converters/transferEventToQueryConverter'),
  expect = require('chai').expect;

module.exports = (ctx) => {

  before(async () => {
    await models.txModel.remove({});
    await models.txLogModel.remove({});
    await models.accountModel.remove({});


    await models.accountModel.create({
      address: ctx.accounts[0],
      balance: 0,
      erc20token: {},
      isActive: true
    });

  });

  it('validate getUpdatedBalance function', async () => {
    const balance = await ctx.web3.eth.getBalance(ctx.accounts[1]);
    expect(parseInt(balance.toString())).to.be.gt(0);

    const erc20contract = new ctx.web3.eth.Contract(erc20token.abi);

    const erc20TokenInstance = await erc20contract.deploy({data: erc20token.bytecode}).send({
      from: ctx.accounts[1],
      gas: 1000000,
      gasPrice: '30000000000000'
    });


    ctx.tx = await erc20TokenInstance.methods.transfer(ctx.accounts[0], 1000).send({from: ctx.accounts[1]});

    let rawTx = await ctx.web3.eth.getTransaction(ctx.tx.transactionHash);
    let rawTxReceipt = await ctx.web3.eth.getTransactionReceipt(ctx.tx.transactionHash);

    const toSaveTx = {
      _id: rawTx.hash,
      index: rawTx.transactionIndex,
      blockNumber: rawTx.blockNumber,
      value: rawTx.value,
      to: rawTx.to,
      nonce: rawTx.nonce,
      gasPrice: rawTx.gasPrice,
      gas: rawTx.gas,
      from: rawTx.from
    };

    await models.txModel.create(toSaveTx);

    rawTxReceipt.logs = rawTxReceipt.logs.map(log => {
      if (log.topics.length)
        log.signature = log.topics[0];
      return log;
    });

    const logsToSave = rawTxReceipt.logs.map(log => {

      let args = log.topics;
      let nonIndexedLogs = _.chain(log.data.replace('0x', '')).chunk(64).map(chunk => chunk.join('')).value();
      let dataIndexStart;

      if (args.length && nonIndexedLogs.length) {
        dataIndexStart = args.length;
        args.push(...nonIndexedLogs);
      }


      const txLog = new models.txLogModel({
        blockNumber: rawTx.blockNumber,
        txIndex: log.transactionIndex,
        index: log.logIndex,
        removed: log.removed,
        signature: _.get(log, 'topics.0'),
        args: log.topics,
        dataIndexStart: dataIndexStart,
        address: log.address
      });

      txLog._id = crypto.createHash('md5').update(`${rawTx.blockNumber}x${log.transactionIndex}x${log.logIndex}`).digest('hex');
      return txLog;
    });

    for (let log of logsToSave)
      await models.txLogModel.create(log);

    rawTx.logs = rawTxReceipt.logs;

    let balanceToken = await erc20TokenInstance.methods.balanceOf(ctx.accounts[0]).call();
    const balances = await getUpdatedBalance(ctx.accounts[0], rawTx);

    expect(balances.balance).to.eq(balance.toString());
    expect(_.find(balances.tokens, {address:erc20TokenInstance.options.address.toLowerCase()}).balance).to.eq(balanceToken.toString());
  });

  it('validate transferEventToQueryConverter function', async ()=>{

    const query = transferEventToQueryConverter({from: ctx.accounts[1], to: ctx.accounts[0], value: 1000..toString(16)});

    const logExist = await models.txLogModel.count(query);
    expect(logExist).to.eq(1);
  });

};
