/*
 * Copyright 2012 Denis Washington <denisw@online.de>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// content_item.js:
// Handles requests concerning single node items
// (/<channel>/content/<node>/<item>).

var api = require('./util/api');
var atom = require('./util/atom');
var pubsub = require('./util/pubsub');
var session = require('./util/session');

/**
 * Registers resource URL handlers.
 */
exports.setup = function(app) {
  app.get('/:channel/content/:node/:item',
          session.provider,
          getNodeItem);
  app.delete('/:channel/content/:node/:item',
           session.provider,
           deleteNodeItem);
};

//// DELETE /<channel>/content/<node>/<id> ////////////////////////////////////////

function deleteNodeItem(req, res) {
  if (!req.user) {
    api.sendUnauthorized(res);
    return;
  }

  var channel = req.params.channel;
  var node = req.params.node;
  var itemId = req.params.item;

  retractNodeItem(req, res, channel, node, itemId, function(reply) {
    res.send(204);
  });
}

//// GET /<channel>/content/<node>/<id> ////////////////////////////////////////

function getNodeItem(req, res) {
  var channel = req.params.channel;
  var node = req.params.node;
  var itemId = req.params.item;

  requestNodeItem(req, res, channel, node, itemId, function(reply) {
    var entry = extractEntry(reply);
    if (!entry) {
      res.send(404);
    } else {
      atom.normalizeEntry(entry);
      api.sendAtomResponse(req, res, entry);
    }
  });
}

function retractNodeItem(req, res, channel, node, item, callback) {
  var nodeId = pubsub.channelNodeId(channel, node);
  var iq = pubsub.singleItemRetractIq(nodeId, item);
  api.sendQuery(req, res, iq, callback);
}

function requestNodeItem(req, res, channel, node, item, callback) {
  var nodeId = pubsub.channelNodeId(channel, node);
  var iq = pubsub.singleItemIq(nodeId, item);
  api.sendQuery(req, res, iq, callback);
}

function extractEntry(reply) {
  var entries = pubsub.extractEntries(reply);
  if (entries.length == 0) {
    return null;
  }
  return entries[0];
}

