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

// content_feed.js:
// Handles requests related to channel node feeds
// (/<channel>/content/<node>).

var iso8601 = require('iso8601');
var ltx = require('ltx');
var api = require('./util/api');
var atom = require('./util/atom');
var config = require('./util/config');
var pubsub = require('./util/pubsub');
var session = require('./util/session');
var grip = require('./util/grip');

/**
 * Registers resource URL handlers.
 */
exports.setup = function(app) {
  app.get('/:channel/content/:node',
          session.provider,
          getNodeFeed);
  app.get('/:channel/next/:node',
          session.provider,
          getNodeFeedNext);
  app.get('/:channel/content/:node/threads',
          session.provider,
          getThreadedNodeFeed);
  app.post('/:channel/content/:node',
           api.bodyReader,
           session.provider,
           postToNodeFeed);
  app.put('/:channel/content/:node',
           api.bodyReader,
           session.provider,
           updateNodeFeed);
};

//// GET /<channel>/content/<node> /////////////////////////////////////////////

function getNodeFeed(req, res) {
  var channel = req.params.channel;
  var node = req.params.node;
  requestNodeItems(req, res, channel, node, function(reply) {
    var feed = generateNodeFeed(channel, node, reply);
    api.sendAtomResponse(req, res, feed.root());
  });
}

function getNodeFeedNext(req, res) {
  var channel = req.params.channel;
  var node = req.params.node;

  var nodeId = pubsub.channelNodeId(channel, node);

  req.session.subscribe(nodeId,
    function(sub) {
      var prevId = null;
      if (req.query.since_post && req.query.since_time) {
        var since_post = req.query.since_post;
        var since_time = Math.floor(iso8601.toDate(req.query.since_time).getTime() / 1000) * 1000;
        console.log("since_post=" + since_post + "&since_time=" + iso8601.fromDate(new Date(since_time)) + " (" + since_time + ")");
        var start = null;
        if (sub.items !== undefined) {
          for (var i = sub.items.length - 1; i >= 0; --i) {
            var si = sub.items[i];
            if (si.id.id == since_post && si.id.time == since_time) {
              start = i + 1;
              prevId = si.id.id + '_' + si.id.time;
              console.log("found in cache at pos=" + i);
              break;
            }
          }
          if (start === null) {
            console.log("checking against " + sub.prevId.id + " " + sub.prevId.time);
            if (sub.prevId && sub.prevId.id == since_post && sub.prevId.time == since_time) {
              start = 0;
              prevId = sub.prevId.id + '_' + sub.prevId.time;
              console.log("found as initial cursor");
            }
          }
        }

        if (start === null) {
          res.send(404);
          return;
        }

        if (start < sub.items.length) {
          var entries = [];
          for (var i = start; i < sub.items.length; ++i) {
            entries.push(sub.items[i].entry);
          }
          var feed = api.generateNodeFeedFromEntries(channel, node, sub.from, entries);
          api.sendAtomResponse(req, res, feed.root());
          return;
        }

        // if we get here, then start == sub.items.length
      }

      // if we get here, then it means since params were not provided, or
      //   the request was since the last known item

      if (req.gripProxied) {
        // if we're behind grip, do a long poll
        var gripChannel = grip.encodeChannel(req.session.jid + '_' + nodeId);
        api.sendHoldResponse(req, res, gripChannel, prevId);
      } else {
        // otherwise respond immediately with empty (plain poll)
        var feed = api.generateNodeFeedFromEntries(channel, node, sub.from, []);
        api.sendAtomResponse(req, res, feed.root());
      }
    },
    function(errstr) {
      res.send(500);
    }
  );
}

function requestNodeItems(req, res, channel, node, callback) {
  var nodeId = pubsub.channelNodeId(channel, node);
  var iq = pubsub.itemsIq(nodeId, req.query.max, req.query.after);
  api.sendQuery(req, res, iq, callback);
}

function generateNodeFeed(channel, node, reply) {
  var feed = new ltx.Element('feed');
  feed.attr('xmlns', atom.ns);
  feed.c('title').t(channel + ' ' + node);

  var nodeId = pubsub.channelNodeId(channel, node);
  var queryURI = pubsub.queryURI(reply.attr('from'), 'retrieve', nodeId);
  feed.c('id').t(queryURI);
  
  var entries = pubsub.extractEntries(reply);
  if (entries.length > 0) {
    var updated = entries[0].getChild('updated');
	if (updated) {
	  feed.c('updated').t(updated.text());
	}
  }
  populateNodeFeed(feed, reply);
  return feed;
}

function populateNodeFeed(feed, reply) {
  var entries = pubsub.extractEntries(reply);
  entries.forEach(function(entry) {
    atom.normalizeEntry(entry);
    feed.cnode(entry.clone());
  });
}

//// POST /<channel>/content/<node> ////////////////////////////////////////////

function postToNodeFeed(req, res) {
  var entry = parseRequestBody(req, res);
  if (!entry) {
    return;
  }

  var channel = req.params.channel;
  var node = req.params.node;

  publishNodeItemAndReturn(req, res, channel, node, entry);
}

function parseRequestBody(req, res) {
  try {
    if (req.is('json') || req.body.toString().match(/^\w*\{/)) {
      return atom.fromJSON(JSON.parse(req.body));
    } else {
      return ltx.parse(req.body);
    }
  } catch (e) {
    res.send(400);
    return null;
  }
}

function publishNodeItem(req, res, channel, node, entry, callback) {
  var nodeId = pubsub.channelNodeId(channel, node);
  var iq = pubsub.publishIq(nodeId, entry.toString());
  api.sendQuery(req, res, iq, callback);
}

function getPublishedItemId(reply) {
  try {
    return reply.
      getChild('pubsub').
      getChild('publish').
      getChild('item').attr('id');
  } catch (e) {
    return null;
  }
}

function getNodeItemUri(channel, node, item) {
  return '/' + [channel, 'content', node, item].join('/');
}

function sendPostAsResponse(req, res, itemId, entry) {
  entry = atom.toJSON(entry.root());
  entry.id = itemId;
  entry.author = req.user.split('/', 2)[0];;
  req.headers['accept'] = req.headers['content-type'];
  api.sendAtomResponse(req, res, atom.fromJSON(entry).root(), 201);
}

//// PUT /<channel>/content/<node> ////////////////////////////////////////////

function updateNodeFeed(req, res) {
  var entry = parseRequestBody(req, res);
  if (!entry) {
    return;
  }

  var channel = req.params.channel;
  var node = req.params.node;

  var nodeId = pubsub.channelNodeId(channel, node);
  var latestIq = pubsub.itemsIq(nodeId, 1);
  api.sendQuery(req, res, latestIq, function(reply) {
    var itemId = getLatestItemId(reply);
    if (itemId) {
      var retractIq = pubsub.singleItemRetractIq(nodeId, itemId);
      api.sendQuery(req, res, retractIq, function(retractReply) {
        publishNodeItemAndReturn(req, res, channel, node, entry);
      });
    } else {
      publishNodeItemAndReturn(req, res, channel, node, entry);
    }
  });
}

function getLatestItemId(reply) {
  var items = pubsub.extractItems(reply);
  if (items.length > 0) {
    return items[0].attr('id');
  } else {
    return null;
  }
}

function publishNodeItemAndReturn(req, res, channel, node, entry) {
  publishNodeItem(req, res, channel, node, entry, function(reply) {
    var itemId = getPublishedItemId(reply);
    if (!itemId) {
      res.send(500);
      return;
    }
    var itemUri = getNodeItemUri(channel, node, itemId);
    res.header('Location', itemUri);
    sendPostAsResponse(req, res, itemId, entry);
  });
}

//// GET /<channel>/content/<node>/threads ////////////////////////////////////////////

function getThreadedNodeFeed(req, res) {
  var channel = req.params.channel;
  var node = req.params.node;
  requestNodeThreads(req, res, channel, node, function(reply) {
    var feed = generateThreadedNodeFeed(channel, node, reply);
    res.contentType('json');
    res.send(feed);
  });
}

function generateThreadedNodeFeed(channel, node, reply) {
  var threads = pubsub.extractThreads(reply);

  var feed = [];

  threads.forEach(function(thread) {
    var entries = thread.getChildrenByFilter(function (c) {
      return typeof c != 'string' && 
        c.getName() == 'entry' && c.getNS() == atom.ns; 
    }, true);
    
    var items = [];
    entries.forEach(function(entry) {
      atom.normalizeEntry(entry);
      items.push(atom.toJSON(entry));
    });
    feed.push({
      'id': thread.attr('id').value(),
      'updated': thread.attr('updated').value(),
      'items': items})
  });

  return feed;
}

function requestNodeThreads(req, res, channel, node, callback) {
  var nodeId = pubsub.channelNodeId(channel, node);
  var iq = pubsub.threadsIq(nodeId, req.query.max, req.query.after);
  api.sendQuery(req, res, iq, callback);
}