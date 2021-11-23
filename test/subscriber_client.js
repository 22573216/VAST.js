const client = require('../lib/client');
require('../lib/common.js');
require('dotenv').config()
const SIZE = 1000; // world size

// my position and AoI to subscribe for PONG messages
var x = process.argv[2] || Math.random()*SIZE;
var y = process.argv[3] || Math.random()*SIZE;
var r = process.argv[4] || 10;


UTIL.lookupIP(process.env.COMPUTER_NAME, function(addr){
    GW_addr = addr;

    C = new client(GW_addr, 20000, x, y, r, function(id){
        _id = id;       
        
        C.subscribe(x, y, r, 'PING');
        // console.log('Client: ' + id + ' subscribing for pings at {x: '+x2+'; y: '+y2+'; radius: '+r2+'}');        
    });

});
