const Redis = require("ioredis");
const { LRUCache } = require('lru-cache');

const CLIENT_ALIVE_EXPIRE_DUTATION = 20;
const PEER_EXPIRE_DUTATION = 10 * 60;
const BREAK_DURATION = 2 * 1000;
let redisCli;
let cache;
let isAlive = false;
let selfAddr;

async function connectUrl(_selfAddr, url) {
    redisCli = new Redis(url);
    initRedis(redisCli, _selfAddr);
}

async function connect(_selfAddr, host, port, username, password, db = 0) {
    redisCli = new Redis({
        port: port, // Redis port
        host: host, // Redis host
        username: username, // needs Redis >= 6
        password: password,
        db: db, // Defaults to 0
    });
    initRedis(redisCli, _selfAddr);
}

async function connectCluster(_selfAddr, addrs, username, password) {
    redisCli = new Redis.Cluster(addrs, {
        redisOptions: {
            username,
            password,
        },
    });
    initRedis(redisCli, _selfAddr);
}

function initRedis(redisCli, _selfAddr) {
    initCache();
    isAlive = true;
    selfAddr = _selfAddr;
}

function getIsAlive() {
    return isAlive
}

function createRedisCli() {
    return redisCli.duplicate()
}

function updateClientCount(count) {
    if (!isAlive) return
    // console.warn(`set ${keyForStats(selfAddr)}`)
    redisCli.set(keyForStats(selfAddr), count, "EX", CLIENT_ALIVE_EXPIRE_DUTATION);
}

async function getNodeClientCount(addr) {
    let count;
    try {
        count = await redisCli.get(keyForStats(addr));
    } catch (e) {
        console.error(e);
        takeABreak();
    }
    if (!count) {
        return -1
    }
    return Number(count)
}

function setLocalPeer(peerId, extra) {
    if (!isAlive) return
    const value =  extra ? `${selfAddr}:${extra}` : selfAddr;
    redisCli.set(keyForPeerId(peerId), value, "EX", PEER_EXPIRE_DUTATION);
}

function delLocalPeer(peerId) {
    if (!isAlive) return
    redisCli.del(keyForPeerId(peerId));
}

function updateLocalPeerExpiration(peerId) {
    if (!isAlive) return
    redisCli.expire(keyForPeerId(peerId), PEER_EXPIRE_DUTATION);
}

function keyForPeerId(peerId) {
    return `signal:peerId:${peerId}`
}

function keyForStats(addr) {
    return `signal:stats:count:${addr}`
}

function keyForMQ(addr) {
    return `signal:mq:${addr}`
}

function pushMsgToMQ(addr, msg) {
    return redisCli.rpush(keyForMQ(addr), msg)
}

async function getLenMQ(addr) {
    let len;
    try {
        len = await redisCli.llen(keyForMQ(addr))
    } catch (e) {
        console.error(e);
        takeABreak();
    }
    if (!len) {
        len = -1;
    }
    return len
}

function clearMQ(addr) {
    redisCli.ltrim(keyForMQ(addr), 1, 0);
}

function trimMQ(addr, len) {
    redisCli.ltrim(keyForMQ(addr), -len, -1);
}

async function blockPopMQ(cli, timeout, addr) {
    const result = await cli.blpopBuffer(keyForMQ(addr), timeout);
    if (!result) return null
    return result[1]
}

function initCache() {
    const options = {
        max: 80000,

        // for use with tracking overall storage size
        // maxSize: 5000,
        // sizeCalculation: (value, key) => {
        //     return 1
        // },

        // for use when you need to clean up something when objects
        // are evicted from the cache
        // dispose: (value, key) => {
        //     freeFromMemoryOrWhatever(value)
        // },

        // how long to live in ms
        // ttl: 1000 * 60 * 5,

        // return stale items before removing from cache?
        allowStale: false,

        updateAgeOnGet: false,
        updateAgeOnHas: false,
    }
    cache = new LRUCache(options)
}

async function getRemotePeerAddr(peerId) {
    let addr = cache.get(peerId);
    if (!addr) {
        try {
            addr = await redisCli.get(keyForPeerId(peerId));
        } catch (e) {
            console.error(e);
        }
        if (addr) {
            cache.set(peerId, addr);
        }
    }
    // 如果是本节点
    if (addr.split(':')[0] === selfAddr) {
        return null
    }
    return addr
}

function takeABreak() {
    isAlive = false;
    setTimeout(() => {
        isAlive = true;
    }, BREAK_DURATION)
}

module.exports = {
    connectUrl,
    connect,
    connectCluster,
    updateClientCount,
    getNodeClientCount,
    getIsAlive,
    setLocalPeer,
    delLocalPeer,
    updateLocalPeerExpiration,
    getRemotePeerAddr,
    getLenMQ,
    pushMsgToMQ,
    clearMQ,
    trimMQ,
    blockPopMQ,
    createRedisCli,
}


