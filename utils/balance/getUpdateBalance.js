/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Kirill Sergeev <cloudkserg11@gmail.com>
 */
const providerService = require('../../services/providerService'),
  models = require('../../models'),
  _ = require('lodash'),
  mongoose = require('mongoose'),
  Promise = require('bluebird'),
  erc20tokenDefinition = require('../../contracts/TokenContract.json');

require('mongoose-long')(mongoose);

module.exports = async (address, tx) => {

  const web3 = await providerService.get();

  const Erc20Contract = web3.eth.contract(erc20tokenDefinition.abi);
  const balances = {};

  if (!tx) {

    let tokens = await models.txModel.aggregate([
      {
        $match: {
          from: address
        }
      },
      {$group: {_id: "$to"}},

      {
        $lookup: {
          from: models.txLogModel.collection.name,
          let: {to: "$_id"},
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {signature: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'},
                    {address: "$$to"}
                  ]
                }
              }
            },
            {$limit: 1}
          ],
          as: "logs"
        }
      },
      {
        $project: {
          from: 1,
          to: 1,
          logs_count: {$size: '$logs'}
        }
      },

      {$match: {logs_count: 1}},
      {$group: {_id: 0, tokens: {$addToSet: "$_id"}}}
    ]);

    tokens = _.get(tokens, '0.tokens', []);

    balances.tokens = await Promise.map(tokens, async token => {
      let balance = await new Promise((res, rej) =>
        Erc20Contract.at(token).balanceOf.call(address, (err, balance) => err ? rej(err) : res(balance))
      );

      return {
        [token]: mongoose.Types.Long.fromString(balance.toString())
      }
    });

  }

  balances.balance = await Promise.promisify(web3.eth.getBalance)(address);

  return balances;
};
