/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const models = require('../../models'),
  _ = require('lodash'),
  contract = require('truffle-contract'),
  erc20token = require('../../contracts/TokenContract.json'),
  erc20contract = contract(erc20token),
  Promise = require('bluebird'),
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
    const balance = await Promise.promisify(ctx.web3.eth.getBalance)(ctx.accounts[0]);
    expect(parseInt(balance.toString())).to.be.gt(0);

    erc20contract.setProvider(ctx.web3.currentProvider);
    const erc20TokenInstance = await erc20contract.new({from: ctx.accounts[1], gas: 1000000});
    ctx.tx = await erc20TokenInstance.transfer(ctx.accounts[0], 1000, {from: ctx.accounts[1]});

    let rawTx = await Promise.promisify(ctx.web3.eth.getTransaction)(ctx.tx.tx);
    let rawTxReceipt = await Promise.promisify(ctx.web3.eth.getTransactionReceipt)(ctx.tx.tx);

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

    let balanceToken = await erc20TokenInstance.balanceOf.call(ctx.accounts[0]);

    const balances = await getUpdatedBalance(ctx.accounts[0], rawTx);

    expect(balances.balance).to.eq(balance.toString());
    expect(_.find(balances.tokens, {address:erc20TokenInstance.address}).balance).to.eq(balanceToken.toString());
  });

  it('validate transferEventToQueryConverter function', async ()=>{


    let rawTxReceipt = await Promise.promisify(ctx.web3.eth.getTransactionReceipt)(ctx.tx.tx);
    const log = rawTxReceipt.logs[0];

    const transferEvent = JSON.parse(JSON.stringify(_.find(ctx.tx.logs, {event: 'Transfer'})));
    transferEvent.args = _.chain(transferEvent.args)
      .toPairs()
      .map((pair, index)=>{
        return [pair[0], log.topics[index + 1] || log.data]
      })
      .fromPairs()
      .value();

    const query = transferEventToQueryConverter(transferEvent.args);

    const logExist = await models.txLogModel.count(query);
    expect(logExist).to.eq(1);
  });

};
