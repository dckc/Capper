/*global require, Map, console, Proxy */
var fs = require("fs");
var Q = require("q");
var caplib = require("./caplib");
function tos(x) {try{return JSON.stringify(x);} catch(e) {
    var xs = "";
    for (var k in x) {xs += k;}
    return x + xs;
}}
module.exports = function(){
    "use strict";
    var dbfile = "capper.db";
    function log(text) {console.log(text);}
    
    var make; var live;
    function rawSend(webkey, method, args) {log("no send implemented");}
    function credToId(cred) {return Object.freeze({"@id": cred });    }
    function idToCred(id) {return id["@id"];}
	
	/*
	 * systate keys are the credentials from the webkey, i.e., "ids".
	 * each value is a map with
	 *   data: the pure data for reviving the object
	 *   reviver: an array of strings for finding the function to revive it
	 *      array[0] is the path to the code to be loaded via require
	 *      array[1] is the optional method to invoke
	*/
	var sysState = {};	
	function loadSysState(){
        if (!fs.existsSync(dbfile)) {fs.writeFileSync(dbfile, "{}");}
        var jsonState = fs.readFileSync(dbfile, 'utf8');
        if (jsonState.length === 0) {jsonState = "{}";}
        console.log("json reloaded, size: " + jsonState.length);
        sysState = JSON.parse(jsonState);
	}
	loadSysState();
    function checkpoint() {
        var vowPair = Q.defer();
	    var jsonState = JSON.stringify(sysState);
        fs.writeFile(dbfile, jsonState, function (err) {
            if (err) {
                console.log("checkpoint failed: " + err); 
                vowPair.reject(err);                
            } else {
                console.log("checkpointed");
                vowPair.resolve(true);
            }
        });
        return vowPair.promise;
	}
	/*
	 * livestate keys are the credentials.
	 * each value is the reference to the corresponding object
	*/
	var liveState = {};

    //each key is the ref to the live object, the value is the id that contains the cred
    var liveToId = new Map();
    
    function asId(ref) {
        if (liveToId.has(ref)){return liveToId.get(ref); }
        throw ("asId bad ref");
    }

    function validStateObj(obj) {
        if (obj === null) {return null;}
        var id = liveToId.get(obj);
        if (id) {return id; }
        for (var key in obj) {
            var nextval = obj[key];
            if (typeof nextval === "function") {
                console.log("!!!ERROR found function in validStateObj " + nextval);
                return null;                
            }
            if (typeof nextval === "object") {
                var childObj = validStateObj(nextval);
                //cannot get here unless the object is valid
                obj[key] = childObj;
            } 
        }
        return obj;
    }
    function drop(id) {
        var cred = idToCred(id);
        liveToId.delete(liveState[cred]); 
        delete liveState[cred];
        delete sysState[cred];         
    }
    function makePersister(data, constructorLocation) {
        var p = Proxy.create({
            //TODO unwind gotten objects to replace ids with persistent objs
            get: function(proxy, key){
                var ans = data[key];
                try { // if the val at key is an id for a persistent obj, return obj
                    var obj = live(ans);
                    ans = obj || ans;
                } catch (e) {}
                return ans;
            },
            set: function(proxy, key, val) {                
                var typ = typeof(val);
                if (typ === "function") {
                    throw "Function in context.state disallowed in " + constructorLocation;                    
                }
                if (typ === "object") {
                    if (val === null) {data[key] = null;}
                    var obj = validStateObj(val);
                    if (obj) {
                        data[key] = obj;                    
                    } else {
                        throw "NonPersistent Object in context.state.set disallowed in "+
                            constructorLocation;
                    }                    
                } else {data[key] = val;}
            },
            has: function(name) {return name in data;}
            //delete, iterate, keys
        });
        return p;    
    }
    function State(id) {
        var cred = idToCred(id);
        var data = sysState[cred].data;
        return makePersister(data, sysState[cred].reviver);
    }
        
    /*
     * Context is a map that contains
     *  make(creationFn, args...) that returns a new persistent object. The
     *      creationFn is a function that receives as first 2 arguments a
     *      context and a state; if state is null, it looks for the args
     *      to do its initial construction, if state is not null, this is
     *      a revival
     *  state is a proxied map that stores the persistent instance data for this
     *     object. Attempts to store functions or nonpersistent objects will throw exceptions.
     *  drop() removes yourself (eventually!) from the persistence system
     *  
	 */
	function makeContext(id, constructorLocation) {
		var newContext = {make: make, state: new State(id)};
		newContext.drop = function() {drop(id);};
		return Object.freeze(newContext);
	}
    
    function reviverToMaker(reviver) {
        var parts = reviver.split(".");
        var path = "./apps/" + parts[0] +"/server/main.js";
        var maker = require(path);
        if (parts.length === 2) {maker = maker[parts[1]];}
        return maker;
    }
	make = function(makerLocation, optInitArgs) {
        var cred = caplib.unique();
        var newId = credToId(cred);
        sysState[cred] = {data: {}, reviver: makerLocation};
		var newContext = makeContext(newId);
        var maker = reviverToMaker(makerLocation); 
		var obj = maker(newContext);
        var initArgs = [];
        for (var i = 1; i <arguments.length; i++) {initArgs.push(arguments[i]);}
        if ("init" in obj) {obj.init.apply(undefined, initArgs);}
		liveState[cred] = obj;
        liveToId.set(obj, newId);
		return obj;
	};
	live = function(id) {
        var cred = idToCred(id);
		var obj = liveState[cred];
		if (obj) { return obj;}
		var revivalData = sysState[cred];
		if (!revivalData) {return null;}
		var context = makeContext(id);
		var maker = reviverToMaker(revivalData.reviver);
		obj = maker(context, revivalData.data);
		liveState[cred] = obj;
        liveToId.set(obj, id);
		return obj;
	};
    function reviver(id) {return sysState[idToCred(id)].reviver;}
	function deliver(id, method, optArgs) {
        var actualArgs = [];
        for (var i = 2; i < arguments.length; i++) {actualArgs.push(arguments[i]);}
        caplib.tvalid(arguments, "os", true, "saver.deliver bad args");
        var ansPair = Q.defer();
		var target = live(id);
        try {
		    var ans = target[method].apply(undefined, actualArgs);
            checkpoint().then(function(ok){
                ansPair.resolve(ans);
            });
        } catch (err) {
            checkpoint().then(function(ok){
                var errMsg = "saver.deliver err on " + reviver(id) + 
                    " method " + method + " " + err;
                log(errMsg);
                ansPair.reject(errMsg); 
            });
        }
        return ansPair.promise;
	}
	var self = {
		clearLive: function() {liveState = {}; liveToId = new Map();},
        reload: function() {
            var vowPairLoaded = Q.defer();
            self.clearLive(); 
            checkpoint().then(function(ok){
                sysState = {}; loadSysState();
                vowPairLoaded.resolve(ok);
            }); 
            return vowPairLoaded.promise;
        },
        zeroSysState: function() {sysState = {};},
		deliver: deliver,
		make: make,
        reviver: reviver,
		asId: asId,
        idToCred: idToCred,
        credToId: credToId,
		live: live,
        checkpoint: checkpoint,
        drop: drop
	};
	return Object.freeze(self);
}();