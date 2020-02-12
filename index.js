const watcher = require('socket.io-client')(process.env.WATCHER_HOST);
const request = require("request");
const bitcoin = require('bitcoinjs-lib');
const elasticsearch = require("elasticsearch");
const express = require("express");
const elasticClient = new elasticsearch.Client({ host: process.env.ELASTICSEARCH_HOST });
const async = require("async");
const supported_layers = ["1"];


const app = express();

function getTxHex(txid, callback) {
  request.get(`${process.env.BITCOIN_API_HOST}/transaction/${txid}`, { json: true }, (err, res, body) => {
    if (err) {
      callback(err);

      return;
    }
    callback(undefined, body.hex);
  })
}

function decodeKoalamentTransaction(hex, callback) {
  let decodedTx = undefined;
  let error = undefined;
  try {
    decodedTx = bitcoin.Transaction.fromHex(hex);
  } catch (e) {
    error = e;
    consoleLogger.error(e);
  }
  if (!decodedTx) {
    callback(error);

    return;
  }
  const hexSplitted = bitcoin.script.toASM(decodedTx.outs[0].script).toString().split(" ");
  if (hexSplitted.length < 2) {
    callback(new Error("Length mismatch."));

    return;
  }
  const splitted = new Buffer(hexSplitted[2], "hex").toString("utf8").split(" ");
  const label = splitted.shift();
  if (label !== "koalament") {
    callback(new Error("Label mismatch."))
    return;
  }
  const layer = splitted.shift();
  if (supported_layers.indexOf(layer) === -1) {
    console.log(`Unknown layer ${layer}`);
    callback(new Error("Unknown layer."));

    return;
  }
  const remained = splitted.join(" ");
  require(`./layers/${layer}`).decode(remained, (err, res) => {
    if (err) {
      console.log(err);
      callback(err);

      return;
    }
    const data = { ...{ _layer: layer }, ...res, ...{ created_at: new Date() } };
    const packData = { ...{ _txid: decodedTx.getId() }, ...data };
    callback(undefined, packData);
  });
}

function indexComment(comment, callback) {
  elasticClient.index({
    index: "koalament",
    type: "koalament",
    id: comment._txid,
    body: comment
  }, (err, response) => {
    callback(err, response);
  })
}

watcher.on("koalament", (hex) => {
  decodeKoalamentTransaction(hex, (err, res) => {
    if (err) {
      throw err;
    }
    indexComment(res, (err, res) => {
      if (err) {
        throw err;
      }
      console.log(err, res)
      console.log("+indexed")
    });
  })
})

app.get("/search/:q", (req, res) => {
  elasticClient.search({
    index: "koalament",
    size: 20,
    body: {
      query: {
        match: {
          text: req.params.q
        }
      }
    }
  }, (err, response) => {
    if (err) {
      res.sendStatus(500);

      return;
    }
    const result = response.hits.hits.map(p => {
      return {
        txid: p._id,
        text: p._source.text,
        url: p._source.key,
        created_at: p._source.created_at
      }
    })
    res.json(result)
  })
})

app.listen(parseInt(process.env.EXPRESS_PORT), "0.0.0.0");