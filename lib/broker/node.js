const redis = require('../broker/redis');
const Aggregator = require('../utils/aggregator');

const PING_INTERVAL = 7 * 1000;
const PING_MAX_RETRYS = 2
const CONSUME_INTERVAL  = 70 * 1000;
const MAX_PIPE_LEN  = 60;

class Node {
    constructor(addr, logger) {
        this.addr = addr;
        this.logger = logger;
        this.isAlive = true;
        this.numClient = 0;
        this.pingRetrys = 0;
        this.isDead = false;
        this.aggregator = new Aggregator(CONSUME_INTERVAL, MAX_PIPE_LEN, (items) => {
            this.sendBatchReq(items);
        })
        this.aggregator.start();
    }

    sendBatchReq(items) {
        // TODO
    }

    sendMsgSignal(signalResp, toPeerId) {
        if (!this.isAlive) {
            this.logger.warn(`node ${this.addr} is not alive when send signal`);
            return false
        }
        this.aggregator.enqueue({
            toPeerId,
            data: signalResp,
        })
        return true
    }

    startHeartbeat() {
        this.timer = setInterval(async () => {
            if (this.pingRetrys > PING_MAX_RETRYS) {
                this.isDead = true
                clearInterval(this.timer);
                return
            }
            const count = await redis.getNodeClientCount(this.addr);
            if (count === -1) {
                this.logger.warn(`node heartbeat ${this.addr} err`);
                if (this.isAlive) {
                    this.isAlive = false;
                    // 清空队列
                    const len = await redis.getLenMQ(this.addr);
                    if (len === -1) {
                        this.logger.warn(`${this.addr} getLenMQ error`);
                    } else if (len > 0) {
                        redis.clearMQ(this.addr);
                    }
                }
                this.pingRetrys ++;
            } else {
                if (!this.isAlive) {
                    this.isAlive = true;
                }
                this.pingRetrys = 0;
                this.numClient = count;
            }
        }, PING_INTERVAL)
    }

    destroy() {
        clearInterval(this.timer);
        this.aggregator.stop();
    }

}

module.exports = Node
