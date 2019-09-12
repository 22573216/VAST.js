
/*
 * VAST, a scalable peer-to-peer network for virtual environments
 * Copyright (C) 2005-2011 Shun-Yun Hu (syhu@ieee.org)
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 */

/*
    Logic for VAST Matcher that performs pub/sub recording & matching

    // basic callback / structure
    settings = {port}
    pos  = {x, y}
    addr = {host, port}
    area = {pos, radius}
    msg  = {from_id, size, type, data, is_reliable}  // message sent & received by clients
    sub  = {sub_id, subscriber, layer, aoi, relay}   // subscription info

    onSubscribed(result, subID)         // callback to receive subscribe result (success/fail)
    onNeighbors(list)                   // callback to receive neighbor (node) list
    onReceive(msg)                      // callback to receive any messages

    // constructor
    VAST_matcher()

    // basic functions

    // stat / accessors

    // state report

    history:
        2012-11-09              initial version (convert from VASTMatcher.h)
*/

require('./common');

var util = util || require('./common/util');

// voronoi computation
var Voronoi = require('./voronoi/vast_voro');

// config
var DEFAULT_RADIUS = 10000; // default radius given to a subscription that does not supply one.

function VAST_matcher(von_peer) {

    var _init = this.init = function (self_id, port, onDone) {
        LOG.layer("Matcher::init called", -1);

        _state = VAST.state.INIT;

        self_id = self_id || VAST.ID_UNASSIGNED;
        _self.id = self_id;

        _is_gateway = _self.id == VAST.ID_GATEWAY;

        LOG.layer("Matcher::init => _self.id set to " + _self.id, _self.id);

        port = port || VAST_DEFAULT_PORT;

        LOG.layer("Matcher::init => port set to " + port, _self.id);

        _msg_handler = _von_peer.getHandler();

        // NOTE: this will cause initStates() be called
        // NOTE: this requires packetHandler, connHandler, disconnHandler and visualComm
        _msg_handler.addHandler(_that);

        // notify done
        if (typeof onDone === 'function')
            onDone(_msg_handler.getAddress());
    }

    this.join = function (gw_addr, aoi, onDone) {
        LOG.layer("matcher::join => join called");
        if (_state === VAST.state.JOINED) {
            LOG.layer("matcher::join => matcher already joined the overlay", _self.id);
            if (typeof onDone === 'function')
                onDone(_self.id);
            return;
        }

        _state = VAST.state.JOINING;

        LOG.layer("matcher::join => called, self: " + _self.id + " getID: " + _getID(), _self.id);

        // store the gateway address
        _gwaddr = new VAST.addr();
        _gwaddr.parse(gw_addr);

        LOG.layer("matcher::join => gateway set to " + _gwaddr.toString(), _self.id);

        if (aoi === undefined) {
            aoi = new VAST.area();
        }

        _join_onDone = onDone;

        LOG.layer("matcher::join => Position set to " + aoi.toString(), _self.id);

        // if gateway matcher, initialise as gateway matcher, else contact gateway matcher to position myself
        LOG.layer("matcher::join => InitMatcher", _self.id);
        _initMatcher(aoi);
    }

    var _sub = this.sub = function (clientID,aoi, channel, type, username) {
        LOG.layer("matcher::sub => subscribing " + clientID + ": " + username + " to " + aoi.toString() + " for channel " + channel);
        // check and make sure that aoi is of the correct type
        if (!aoi.hasOwnProperty("center") || !aoi.hasOwnProperty("radius")) {
            LOG.layer("matcher::sub => aoi is not of the correct type. Ignore subscription", _self.id);
            return false;
        }


        // create sub object
        var sub = new VAST.sub(_self.id, clientID, channel, aoi, type, username);

        // store sub in subscription list
        _subscriptions[sub.subID] = sub;

        // check to see if the sub needs to be propogated to other matchers
        _checkOverlap(sub);
    }

    var _unsub = this.unsub = function (clientID, channel, username){
        LOG.layer("matcher::unsub => unsubscribing from " + channel + " for " + clientID + ": " + username);

        var aoi = new VAST.area();

        var sub = new VAST.sub(_self.id, clientID, channel, aoi, connections[clientID], username);

        if (!_subscriptions.hasOwnProperty(sub.subID)) {
            LOG.error("matcher::removeSubscriptions => sub with sub ID:" + sub.subID + " does not exist. Ignore.");
            return false;
        }

        sub = _subscriptions[sub.subID];
        _removeSubscriptions(sub);
    }

    var _pub = this.pub = function (clientID, player, aoi, message, channel, packetName, originID, oldTargets) {
        LOG.layer("matcher::pub => publishing packet from " + player + " on channel " + channel +" to " + aoi.toString());

        // create the publication pack with payload and username in the msg field
        var msg = {
            clientID: clientID,
            username:   player,
            payload:    message,
            aoi:        aoi,
            channel:    channel,
            packetName: packetName,
            oldTargets: [],
            originID: _self.id
        };

        LOG.layer("msg:");
        LOG.layer(msg);

        var pack = new VAST.pack(Matcher.PUB, msg, VAST.priority.HIGHEST, LAYER.MATCHER, clientID);

        var clientSend = [];

        // TODO: Check how sending to server from client and to client from server works
        // loop through subs to find which ones overlap with pub aoi
        for (var key in _subscriptions) {
            var sub = _subscriptions[key];

            LOG.layer("matcher::pub => sub:");
            LOG.layer(sub);

            // skip if the sub is for the same type of connection
            if (sub.type == connections[clientID]) {
                LOG.layer("matcher::pub => " + sub.type + " cannot send to the same type");
                continue;
            }

            // skip if it is not on the right channel
            if (sub.channel != channel) {
                LOG.layer("matcher::pub => channels do not match. Ignore sub");
                continue;
            }

            // if the publish area covers the subscription area then process it
            // TODO: Add publication propagation for when aoi is outside of region
            if (sub.aoi.covers(aoi)) {
                LOG.layer("matcher::pub => sub area covers aoi");
                // if we are not the host of the sub or if this is a propagated publication,
                // then send the publication to that matcher for them to process
                if (sub.host_id != _self.id && originID == _self.id) {
                    LOG.layer("matcher::pub => self ID does not match host_id", _self.id);
                    // add host to pack targets if hasn't already been added or hasn't been sent to before
                    LOG.layer(pack.targets);
                    if (!pack.targets.hasOwnProperty(sub.host_id) && !oldTargets.hasOwnProperty(sub.host_id)) {
                        LOG.layer("matcher::pub => adding [" + sub.host_id + "] to list of matchers to send to", _self.id);
                        pack.targets.push(sub.host_id);
                    }
                } else {
                    LOG.layer("matcher::pub => self ID matches host_id", _self.id);
                    // add id to list of clients to publish to
                    // don't add if it is already added and don't send it to the client publishing
                    if (!clientSend.hasOwnProperty(sub.id) && sub.id != clientID) {
                        LOG.layer("matcher::pub => adding " + sub.id + " to the sending list and to the oldTargets list of the propagation pack", _self.id);
                        clientSend.push(sub.id);
                        pack.msg.oldTargets.push(sub.id);
                    }
                }
            } else
                LOG.layer("matcher::pub => no intersection. Look at the next subscription");
        }

        // TODO: This is an application-specific implementation. Devise an application-agnostic solution
        // NOTE: The same above in adding to clients to send to
        if (packetName != "HandshakePacket" && packetName != "EstablishConnectionPacket") {
            _sendPack(pack, true);
        } else LOG.layer("matcher::pub => do not forward login packets to prevent login to servers that aren't the host server.", _self.id);

        LOG.layer("Sending packet to");
        LOG.layer(clientSend);

        // loop through client list to send to clients connected to this matcher
        for (var i = 0; i < clientSend.length; i++) {
            // create return data object and send to clients
            var returnData = {
                clientID: clientSend[i],
                payload: msg
            }
            LOG.layer("matcher::pub => returning data to net layer");
            LOG.layer(returnData);
            _clientReturn("publish", returnData);
        }
    }

    var _leave = this.leave = function (clientID) {
        // create a sub ID that may be associated with the client
        var subID = _self.id + "-" + clientID;
        var sub;

        // check whether sub exists, but if it doesn't, manually search for it
        if (_subscriptions.hasOwnProperty(subID)) {
            sub = _subscriptions[subID];
        } else {
            for (var key in _subscriptions) {
                if (_subscriptions[key].id == clientID && _subscriptions[key].host_id == _self.id) {
                    sub = _subscriptions[key];
                    break;
                }
            }
        }

        // check to see if there is a sub to remove, else remove the client from local records
        if (sub == undefined)
            return false;

        _removeSubscriptions(sub);
    }

    var _move = this.move = function (clientID, aoi, channel, hostID) {
        LOG.layer("matcher::move => moving [" + clientID + "] to <" + aoi.center.x + "," + aoi.center.y + "> with radius " + aoi.radius);

        // generate subID of the subscriptions belonging to the moving client
        var subID = _generateSubID(clientID, hostID, channel);

        if (!_subscriptions.hasOwnProperty(subID)) {
            LOG.layer("matcher::move => subID " + subID + " does not exist. Cannot move client subscription", _self.id);
            return false;
        }

        _updateSubscription(subID, aoi, 0, true);
    }

    var _query = this.query = function (contact_id, center, msg_type, msg_para) {
        LOG.layer('matcher::query => matcher will contact node [' + contact_id + '] to find acceptor', _self.id);

        var msg = {
            pos: center,
            type: msg_type,
            para: msg_para
        }

        //send out query request
        _sendMessage(contact_id, Matcher_msg.QUERY, msg, VAST.priority.HIGHEST, true, LAYER.MATCHER);
    }

    var _initMatcher = function (aoi) {
        LOG.layer("matcher::initMatcher => get ID and insert into local view", _self.id);
        _self.id = _getID();
        LOG.layer("matcher::initMatcher => ID: " + _self.id);

        var addr = _msg_handler.getAddress();
        addr = new VAST.endpt(addr.host, addr.port);

        LOG.layer("matcher::initMatcher => addr: ");
        LOG.layer(addr);
        _self.endpt.update(addr);
        _self.region.site.update(aoi.center);

        LOG.layer("matcher::initMatcher => matcher region updated " + _self.region.toString());

        // insert self into local view
        _insertMatcher(_self);

        LOG.layer("matcher::initMatcher => matcher inserted into local view");

        // TODO: Set up visual for this

        // Setup done, waiting for neighbour information from VON layer
        _setJoined();
    }

    // set current node to be 'joined'
    var _setJoined = function () {
        _state = VAST.state.JOINED;

        if (typeof _join_onDone === 'function')
            _join_onDone(_self.id, _msg_handler);

        return true;
    }

    var _generateSubID = function (clientID, hostID, channel) {
        return (hostID + "-" + clientID + "-" + channel);
    }

    /*
        Positional functions
    */

    // check whether two clients reside in the same position
    var _isOverlapped = function (checkPos, checkID) {
        // check position against neighbours for overlap
        LOG.layer(_neighbours);
        for (var id in _neighbours) {
            var pos = _neighbours[id].region.site;
            if ((pos.equals(checkPos)) && id != checkID) {
                LOG.layer("Overlap detected", _self.id);
                return true;
            }
        }
        LOG.warn("no overlap");

        return false;
    }

    // move position slightly so that there is no overlap
    var _adjustPos = function (pos, id) {
        do {
            // adjust position randomly between -0.1 and 0.1
            pos.x += Math.random()-0.1;
            pos.y += Math.random()-0.1;

            // make sure the pos is within boundaries of region
            pos = _bound(pos);
            LOG.layer("Position adjusted to ("+pos.x+","+pos.y+")", _self.id);
        } while (_isOverlapped(pos, id));

        return pos;
    }

    // check that node is within the bounds of the bbox
    var _bound = function (pos) {
        var bbox = _voro.get_bounding_box();
        if (pos.x < bbox.xl+0.5)         pos.x = bbox.xl;
        if (pos.y < bbox.yt+0.5)         pos.y = bbox.yt;
        if (pos.x > bbox.xr-0.5)         pos.x = bbox.xr;
        if (pos.y > bbox.yb-0.5)         pos.y = bbox.yb;
        return pos;
    }

    var _contains = function (subPos, matcherRegion) {
        // get number of halfedges in voronoi section
        var nvert = matcherRegion.halfedges.length;

        if (matcherRegion.intersects(subPos.center,subPos.radius))
            return true;

        return false;
    }

    var _nodeToMatcher = function (node) {
        //LOG.layer("matcher::nodeToMatcher => node being converted to matcher: ", _self.id);
        //LOG.layer(node);
        // initialise matcher object
        var matcher = new VAST.match(node.id, node.endpt, node.time);
        //LOG.layer("Matcher from node:");
        //LOG.layer(matcher);

        var region = _voro.getRegion(matcher.id);

        if (region != undefined) {
            LOG.layer("matcher::nodeToMatcher => matcher is already inserted into the voronoi. Update with local view.", _self.id);
            matcher.region.update(region);
            matcher.region.convertEdges();
        } else {
            LOG.layer("matcher::nodeToMatcher => matcher has not been added to the local view. Update manually", _self.id);
            matcher.region.init(node.aoi.center);
        }

        //LOG.layer("New matcher:", _self.id);
        //LOG.layer(matcher);

        return matcher;
    }

    var _checkOverlap = function (sub) {
        LOG.layer("matcher::checkOverlap => checking overlap for sub: " + sub.toString());
        // list of overlapping neighbours
        var overlap = [];
        var tempMatcher = undefined;

        // loop through regions and check for overlaps
        for (var key in _neighbours) {
            // don't check self region
            if (key == _self.id)
                continue;

            tempMatcher = _getMatcher(key);

            if (_contains(sub.aoi, tempMatcher.region)) {
                overlap.push(key);
            }
        }

        // send messages to overlapped regions
        if (overlap.length > 0) {
            LOG.layer("matcher:checkOverlap => " + overlap.length + " overlapping neighbours. Sending sub to them: " + overlap);
            sub.recipients = overlap;
            _subscriptions[sub.subID] = sub;
            LOG.layer("matcher:checkOverlap => sending sub message");
            _sendMessage(overlap, Matcher.SUB_NOTIFY, sub, VAST.priority.NORMAL, true, LAYER.MATCHER);
        } else {
            LOG.layer("matcher::checkOverlap => There are no overlapping regions to send this subscription to");
        }
    }

    /*
        subscription maintain
    */

    // create a new subscriber instance at this VASTMatcher
    var _addSubscription = function (sub, is_owner) {
        LOG.layer("matcher::addSubscription => adding subscription to matcher.", _self.id);
        // do not add if there's an existing subscription
        if (_subscriptions.hasOwnProperty(sub.id))
            return false;

        // recreate sub so that internal functions that were lost in transfer over socket can be reestablished
        var new_sub = new VAST.sub();
        new_sub.parse(sub);

        // record a new subscription
        _subscriptions[new_sub.subID] = new_sub;

        // add type to connections for publication checking
        connections[new_sub.id] = new_sub.type;

        LOG.layer("matcher::addSubscription => subscription successfully added. New subscription list:", _self.id);
        LOG.layer(_subscriptions);

        return true;
    }

    // remove subscription
    var _removeSubscriptions = function (sub) {
        // make sure that the sub exists
        if (sub === undefined) {
            LOG.error("matcher::removeSubscriptions => subscription information is non-existent");
            return false;
        }

        // remove the subscription
        // and if I am the host ID, send remove subscription message to others
        if (sub.host_id == _self.id) {
            _sendMessage(sub.recipients, Matcher.SUB_REMOVE, sub, VAST.priority.NORMAL, true, LAYER.MATCHER);
        }

        delete _subscriptions[sub.subID];
    }

    // update a subscription content
    var _updateSubscription = function(sub_ID, new_aoi, sendtime, is_owner) {
        LOG.layer("matcher::updateSubscription => updating " + sub_ID + " with aoi " + new_aoi.toString());
        // check to see if we have a record of the subscription being updated
        if (!_subscriptions.hasOwnProperty(sub_ID)) {
            LOG.layer("matcher::updateSusbcription => updating subscription with ID: " + sub_ID, _self.id);
            return false;
        }

        var sub = _subscriptions[sub_ID];
        var hostID = is_owner ? _self.id : sub.host_id;
        var updateSub = new VAST.sub(hostID, sub.id, sub.layer, new_aoi, connections[sub.id], sub.username, sendtime);

        sub.update(updateSub);

        LOG.layer("matcher::updateSubscriptions => updated sub");
        LOG.layer(sub);

        _subscriptions[sub.subID] = sub;
        // TODO: send out update subscription to neighbour matchers
    }

    //check if a disconnecting host contains subscribers
    var _matcherDisconnected = function(host_id) {

    }


    /*
        check helpers
    */

    // checks if ID is my ID
    var _isSelf = function (id) {
        LOG.layer("Checking if self " + id);
        return (_self.id == id);
    }

    // check if a given ID is an existing neighbor
    var _isNeighbor = this.isNeighbor = function (id) {
        LOG.layer("Checking if neighbour: " + id);
        return _neighbours.hasOwnProperty(id);
    }

    /*
        send messages to matchers
    */

    /*
        matcher node handlers
    */

    var _insertMatcher = this.insertMatcher = function (matcher) {
        LOG.layer("matcher::insertMatcher => insert matcher into the local view", _self.id);

        // first check for an overlap before inserting into voronoi
        if (_isOverlapped(matcher.region.site, matcher.id)) {
            LOG.layer("matcher::insertMatcher => Adjusting local position for client [" + matcher.id + "] before inserting into voronoi", _self.id);
            node.region.site.update(_adjustPos(matcher.region.site,matcher.id));
        }

        LOG.layer("matcher::insertMatcher => Inserting into voronoi");
        // store the new matcher
        if (!_voro.insert(matcher.id, matcher.region.site)) {
            LOG.layer("matcher::insertMatcher => insert matcher failed", _self.id);
            return false;
        }

        LOG.layer("matcher::insertMatcher => successfully inserted matcher into voro");

        // add halfedges from voronoi to matcher region
        matcher.region.update(_voro.getRegion(matcher.id));
        LOG.layer(matcher);
        var before = util.getTimestamp();
        matcher.region.convertEdges();
        var after = util.getTimestamp();
        LOG.layer("matcher::insertMatcher => time taken to do edge conversion: " + (after - before), _self.id);

        LOG.layer(matcher.region);

        // store matcher into neighbour list
        _neighbours[matcher.id] = matcher;

        LOG.layer("matcher::insertMatcher => matcher ID: " + matcher.id + " selfID: " + _self.id, _self.id);
        if (matcher.id == _self.id) {
            LOG.layer("matcher::insertMatcher => updating self node's region information", _self.id);
            _self.update(matcher);
        }

        LOG.layer("matcher::insertMatcher => Neighbour list after insert");
        LOG.layer(_neighbours);

        return true;
    }

    var _updateMatcher = this.updateMatcher = function (node) {
        LOG.layer("I'm meant to be updating the matcher info here");
    }

    var _contactNewMatchers = this.contactNewMatchers = function () {
        LOG.layer("matcher::contactNewMatchers => starting the contacting of newly received matcher info");
        LOG.layer(_new_neighbours);
        // check if any new neighbors to contact
        if (Object.keys(_new_neighbours).length === 0)
            return;

        //
        // new neighbor notification check
        //
        var new_list = [];      // list of new, unknown nodes
        var target;

        // loop through each notified neighbor and see if it's unknown
        for (var target in _new_neighbours) {
            LOG.layer("matcher::newNeighbours => looking at target ID: " + target);

            // NOTE: be careful that 'target' is now of type 'string', not 'number'
            var new_node = _new_neighbours[target];

            var new_matcher = _nodeToMatcher(new_node);

            LOG.layer("matcher::contactNewMatchers => converted node:",_self.id);
            LOG.layer(new_matcher, _self.id);

            // ignore self
            if (_isSelf(new_matcher.id))
                continue;

            // update existing info if the node is known, otherwise prepare to add
            if (_isNeighbor(new_matcher.id)) {
                LOG.layer("matcher::contactNewMatchers => updating existing matcher.", _self.id);
                _updateMatcher(new_matcher);
            } else {
                LOG.layer("matcher::contactNewMatchers => adding new matcher.");
                // insert to Voronoi and get ready to propogate it to make contact with them
                _insertMatcher(new_matcher);

                // TODO: change from unused to either removed or handled
                new_list.push(new_matcher.id);
            }
        }


    }

    var _sendRelevantSubs = this.sendRelevantSubs = function (target) {
        LOG.layer("matcher::sendRelevantSubs => Finding subscriptions to send to " + target, _self.id);

        if (!_neighbours.hasOwnProperty(target)) {
            LOG.error("matcher::sendRelevantSubs => neighbour " + target + " is no longer a neighbour. Ignore relevant subs request");
            return false;
        }

        // get neighbour matcher information in temporary variable
        var neighbour = _getMatcher(target);

        var relevant_subs = {}

        // run through list of subscriptions and check for relevant ones to neighbour
        for (var key in _subscriptions) {
            // TODO: update contains
            if (_contains(_subscriptions[key].aoi, neighbour.region)) {
                LOG.layer("matcher::sendRelevantSubs => adding " + key + " to list of subs relevant to " + target, _self.id);
                var sub = _subscriptions[key];
                relevant_subs[key] = sub;
            }
        }

        _sendMessage(target, Matcher.SUB_TRANSFER, relevant_subs, VAST.priority.NORMAL, true, LAYER.MATCHER);
    }

    // retrieve a matcher with updated halfedges
    // NOTE: should not be used in loops as it recalculate's voronoi every time
    var _getMatcher = this.getMatcher = function (matcherID) {
        LOG.layer("matcher::getMatcher => Retrieving matcher with ID: " + matcherID + " and updating its halfedges.");
        var matcher = _neighbours[matcherID];
        matcher.region.update(_voro.getRegion(matcherID));
        LOG.layer("matcher::getMatcher => updated matcher. Convert edges next")
        matcher.region.convertEdges();
        LOG.layer("matcher::getMatcher => conversion of matcher complete.");

        _neighbours[matcherID] = matcher;
        return matcher;
    }

    /*
        handlers
    */

    // handles packets from other matchers
    var _packetHandler = this.packetHandler = function (from_id, pack) {

        LOG.layer('matcher::packetHandler => [' + _self.id + '] ' + Matcher_string[pack.type] + ' from [' + from_id + '], neighbor size: ' + Object.keys(_neighbours).length, _self.id);


        switch (pack.type) {

            // receive a list of nodes that matcher should be aware of
            case Matcher.NODE: {
                var nodelist = pack.msg;
                LOG.layer("matcher::packetHandler::NODE => receiving information about nodes. Number of nodes: " + nodelist.length);
                LOG.layer(pack);
                for (var i = 0; i < nodelist.length; i++) {
                    // check the node to make sure that the information is legitimate
                    if (nodelist[i].id === undefined ||
                        nodelist[i].endpt === undefined ||
                        nodelist[i].aoi === undefined) {
                            LOG.layer("matcher::packetHandler => nodelist node has invalid data: "+nodelist[i].msg);
                            // TODO: create error message that gets information again
                            break;
                    }

                    //extract message
                    var new_node = new VAST.node();
                    new_node.parse(nodelist[i]);

                    LOG.layer('matcher::packetHandler => node ' + new_node.toString(), _self.id);

                    // store the new node and process later
                    // if there's existing notification, then replace only if newer
                    if (!_new_neighbours.hasOwnProperty(new_node.id) ||
                        _new_neighbours[new_node.id].time <= new_node.time) {

                        LOG.layer('matcher::packetHandler => adding node id [' + new_node.id + '] type: ' + typeof new_node.id, _self.id);

                        _new_neighbours[new_node.id] = new_node;
                    }
                }
                _contactNewMatchers();
            }
                break;

            // receive information about a node that has joined, respond with subs that it needs to know about
            case Matcher.HELLO : {
                LOG.layer("matcher::HELLO => receiving information about neighbour node");
                var node = pack.msg;

                var matcher = _nodeToMatcher(node);

                _insertMatcher(matcher);

                _sendRelevantSubs(matcher.id);

                // TODO: send back information about subscriptions
            }
                break;

            // receive list of subscriptions from nodes that matcher should know about
            case Matcher.SUB_TRANSFER: {
                LOG.layer("matcher::subTransfer => receiving subscriptions from [" + from_id + "]", _self.id);
                var sub_list = pack.msg;

                // insert subscriptions into local list
                for (var key in sub_list) {
                    var sub = sub_list[key];
                    var is_owner = sub.host_id == _self.id ? true : false;
                    LOG.layer("matcher::sub_transfer => adding sub : " + sub, _self.id);
                    _addSubscription(sub, is_owner);
                }
            }
                break;

            // remove subscription
            case Matcher.SUB_REMOVE: {
                LOG.layer("matcher:: packetHandler::SUB_REMOVE => received notification to remove a subscription", _self.id);
                var sub = pack.msg;

                // remove subscription
                _removeSubscriptions(sub);
            }
                break;

            // information about a subscription that anothe matcher thinks we should know about
            case Matcher.SUB_NOTIFY: {
                LOG.layer("matcher::packetHandler::SUB_NOTIFY => received information about a subscription that we should be aware of.", _self.id);

                var sub = pack.msg;

                // add subscription to own view
                _addSubscription(sub, false);
            }
                break;

            case Matcher.PUB: {
                LOG.layer("matcher:packetHandler => Publish message to client.", _self.id);

                var aoi = new VAST.area();
                aoi.parse(pack.msg.aoi);

                if (pack.msg.packetName == "ServerEntityPositionPacket" || pack.msg.packetName == "ServerEntityPositionRotationPacket") {
                    _move(pack.msg.clientID, aoi, pack.msg.channel, from_id);
                }

                _pub(pack.msg.clientID, pack.msg.username, aoi, pack.msg.payload, pack.msg.channel, pack.msg.packetName, pack.msg.originID, pack.msg.oldTargets);
            }
                break;

            // receive request to assign a new ID if I am the gateway, and if I am not, receive client ID for the connecting client
            case Matcher.ID: {
                if (_is_gateway) {
                    LOG.layer("matcher::packetHandler::ID => Received ID request. Assign new ID and respond", _self.id);
                    _clientID++;
                    var returnData = {
                        type: pack.msg.type,
                        clientID: _clientID,
                        socketID: pack.msg.socketID
                    }
                    _sendMessage(from_id, Matcher.ID, returnData, VAST.priority.NORMAL, true, LAYER.MATCHER);
                } else {
                    LOG.layer("matcher::packetHandler::ID => I am not the gateway. Receiving ID for connecting client.",_self.id);
                    _clientID = pack.msg.clientID;

                    // decrease the local ID by one after assigning so that when connHandler::type increases it, it will match the received ID.
                    _clientID--;

                    var data = {
                        type: pack.msg.type,
                        socketID: pack.msg.socketID
                    }

                    // tell connHandler to accept an ID
                    _receiveID = true;

                    LOG.layer("matcher::packetHandler::ID => redirecting to connHandler.", _self.id);
                    _connHandler("type", data);
                }
            }
                break;

            default: {
                LOG.layer("matcher::packetHandler => Packet successfully received");
                LOG.layer(pack);
            }
                break;
        }

        return true;
    }

    // handles messages from connections from clients
    var _connHandler = this.connHandler = function (type,data) {
        // handle the type of message coming through
        LOG.layer("type: " + type);
        LOG.layer("data: ");
        LOG.layer(data);

        switch (type) {
            case "type": {
                LOG.layer("matcher::connHandler => received connection of type: " + type, _self.id);
                if (_is_gateway || _receiveID) {
                    LOG.layer("matcher::connHandler::type => Accept connection. _is_gateway: " + _is_gateway + " _receiveID: " + _receiveID, _self.id);
                    _receiveID = false;
                    _clientID++;
                    connections[_clientID] = data.type;
                    LOG.layer("matcher::connHandler => connections:", _self.id);
                    LOG.layer(connections, _self.id);
                    var returnData = {
                        socketID: data.socketID,
                        connectionID: _clientID
                    }
                    _clientReturn(type, returnData);
                } else {
                    LOG.layer("matcher::connHandler => I am not the gateway and so I cannot assign the client ID. Request client id from " + _gwaddr.toString(), _self.id);
                    _sendMessage(VAST.ID_GATEWAY, Matcher.ID, data, VAST.priority.NORMAL, true, LAYER.MATCHER);
                }
            }
                break;

            case "join": {
                LOG.layer("matcher::join => received username " + data.username);
                _clientID++;

                // create space for client info to be stored
                connections[_clientID] = data.type;
                LOG.layer("matcher::connHandler => connections:", _self.id);
                LOG.layer(connections, _self.id);

                // construct return data
                var returnData = {
                    clientID: _clientID,
                    username: data.username,
                    socketID: data.socketID
                }
                _clientReturn(type, returnData);
            }
                break;

            case "subscribe": {
                LOG.layer("matcher::connHandler => received subscription request", _self.id);

                // set large sub radius if the connection doesn't initially provide one
                // make it large enough that the initial messages will be captured
                if (data.radius == undefined) {
                    LOG.layer("matcher::subscribe => No radius provided. Making it the default radius of " + DEFAULT_RADIUS, _self.id);
                    data.radius = DEFAULT_RADIUS;
                }

                var aoi = new VAST.area(new VAST.pos(data.x,data.y), data.radius);

                // increase the clientID if it is of type client
                var clientID = data.clientID;

                // handle case where client is subscribing before joining
                var type = connections[clientID] == undefined ? "client" : connections[clientID];

                _sub(clientID, aoi, data.channel, type, data.username);
            }
                break;

            case "unsubscribe": {
                LOG.layer("matcher::connHandler => received unsubscribe request", _self.id);
                _unsub(data.clientID, data.channel, data.username);
            }
                break;

            case "move": {
                LOG.layer("matcher::connHandler::move => received move request from " + data.clientID, _self.id);
                var aoi = new VAST.area(new VAST.pos(data.x,data.y),data.radius);
                _move(data.clientID, aoi, data.channel, _self.id);
            }
                break;

            case "publish": {
                LOG.layer("matcher::connHandler => received publication request", _self.id);
                var aoi = new VAST.area(new VAST.pos(data.x,data.y), data.radius);

                _pub(data.clientID, data.username, aoi, data.payload, data.channel, data.packetName, _self.id, []);
            }
                break;
            default:

        }
    }

    var _disconnHandler = this.disconnHandler = function () {

    }

    // var visualComm = this.visualComm = function (type, message) {}

    /*
        Instantiation functions and variables
    */

    // clean up all internal states for a new fresh join
    var _initStates = this.initStates = function (msg_handler) {
        LOG.layer ("Matcher::initStates => initStates called", _self.id);

        if (_msg_handler != undefined) {
            LOG.layer('VAST_matcher initStates called with msg_handler, id: ' + _self.id, _self.id);

            // add convenience references
            _getID =        _msg_handler.getID,
            _disconnect =   _msg_handler.disconnect,
            _sendMessage =  _msg_handler.sendMessage,
            _sendPack =     _msg_handler.sendPack;
            _clientReturn = _msg_handler.clientReturn;
        }

        _neighbours = {};
        _new_neighbours = {};

        _voro = new Voronoi();

        _subscriptions = {};

        _clientID = -1;
    }

    /////////////////////
    // constructor
    //
    LOG.layer('matcher constructor called', -1);

    // list of subscriptions
    var _subscriptions;

    // list of neighbouring matchers
    var _neighbours;

    // list of new neighbouring matchers to contact
    var _new_neighbours;

    // the ID of the origin matcher (the gateway matcher)
    var _origin_id;

    // the ID of this matcher (coincides with VON peer. ID from the net layer)
    var _self = new VAST.match();

    // local copy of the voronoi diagram
    var _voro;

    // local reference to self
    var _that = this;

    // local reference to message handler
    var _msg_handler = undefined;

    // reference to matcher's VON peer
    var _von_peer = von_peer;

    // convenience references
    var _getID, _disconnect, _sendMessage, _sendPack, _join_onDone;

    // the state of the matcher
    var _state;

    // connections
    var connections = {};

    // am I the gateway or not
    var _is_gateway;

    // if I am receiving a client ID from the gateway
    var _receiveID = false;

    // gateway address
    var _gwaddr;

    // client ID
    var _clientID;

    // client ID to client type
    var _id2type = {};

}

// export the class with conditional check
if (typeof module !== "undefined")
	module.exports = VAST_matcher;