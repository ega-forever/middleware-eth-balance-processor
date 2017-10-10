# middleware-eth-balance-processor [![Build Status](https://travis-ci.org/ChronoBank/middleware-eth-balance-processor.svg?branch=master)](https://travis-ci.org/ChronoBank/middleware-eth-balance-processor)

Middleware service for handling user balance

###Installation

This module is a part of middleware services. You can install it in 2 ways:

1) through core middleware installer  [middleware installer](https://github.com/ChronoBank/middleware)
2) by hands: just clone the repo, do 'npm install', set your .env - and you are ready to go

##### About
This module is used for updating balances for registered accounts (see a description of accounts in [block processor](https://github.com/ChronoBank/middleware-eth-blockprocessor)).

##### сonfigure your .env

To apply your configuration, create a .env file in root folder of repo (in case it's not present already).
Below is the expamle configuration:

```
MONGO_URI=mongodb://localhost:27017/data
RABBIT_URI=amqp://localhost:5672
NETWORK=development
```

The options are presented below:

| name | description|
| ------ | ------ |
| MONGO_URI   | the URI string for mongo connection
| RABBIT_URI   | rabbitmq URI connection string
| NETWORK   | network name (alias)- is used for connecting via ipc (see block processor section)

License
----

MIT