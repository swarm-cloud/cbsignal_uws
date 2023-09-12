const redis = require('../broker/redis');
const Aggregator = require('../utils/aggregator');
const { getProtoBuf } = require('../utils/protoBuf');

const CONSUME_INTERVAL  = 100;
const MAX_PIPE_LEN  = 60;
const MQ_MAX_LEN = 1000;
const MQ_LEN_AFTER_TRIM = 500;

class Node {
    constructor(addr, logger) {
        this.addr = addr;
        this.logger = logger;
        this.isAlive = true;
        this.numClient = 0;
        this.pingRetrys = 0;
        this.timer = null;
        this.aggregator = new Aggregator(CONSUME_INTERVAL, MAX_PIPE_LEN, async (items) => {
            this.sendBatchReq(items);
        })
        this.aggregator.start();
    }

    async sendBatchReq(items) {
        // console.warn(`sendBatchReq ${new Date()}`)
        const batchReq = {
            items,
        }
        // const errMsg = this.ProtoBuf.verify(batchReq);
        // if (errMsg) {
        //     this.logger.error(errMsg);
        //     return
        // }
        const ProtoBuf = getProtoBuf();
        if (!ProtoBuf) {
            this.logger.error(`ProtoBuf not found`);
            return
        }
        const message = ProtoBuf.create(batchReq);
        const buffer = ProtoBuf.encode(message).finish();
        try {
            const length = await redis.pushMsgToMQ(this.addr, buffer);
            if (length > MQ_MAX_LEN) {
                this.logger.warn(`before trim ${this.addr}, len ${length}`);
                await redis.trimMQ(this.addr, MQ_LEN_AFTER_TRIM);
                const curLength = await redis.getLenMQ(this.addr);
                this.logger.warn(`trim ${this.addr} done, current len ${curLength}`);
            }
        } catch (e) {
            this.logger.error(e);
        }
    }

    sendMsgSignal(signalResp, toPeerId) {
        if (!this.isAlive) {
            // this.logger.warn(`node ${this.addr} is not alive when send signal`);
            return false
        }
        this.aggregator.enqueue({
            toPeerId,
            data: Buffer.from(JSON.stringify(signalResp)),
        })
        return true
    }

    destroy() {
        if (this.timer) clearInterval(this.timer);
        this.aggregator.stop();
    }

}

module.exports = Node
