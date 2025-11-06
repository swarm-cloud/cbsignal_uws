const redis = require('../broker/redis');
// const Aggregator = require('../utils/aggregator');
const Aggregator = require('../utils/aggregator_v2');
const { getProtoBuf } = require('../utils/protoBuf');

const MQ_MAX_LEN = 300;
const MQ_LEN_AFTER_TRIM = 150;

class Node {
    constructor(addr, logger, msgConsumeInterval = 60, maxPipeLen = 1000) {
        this.addr = addr;
        this.logger = logger;
        this.isAlive = true;
        this.shouldCheck = false;
        this.numClient = 0;
        this.pingRetrys = 0;
        this.timer = null;
        this.aggregator = new Aggregator(msgConsumeInterval, maxPipeLen, async (items) => {
            this.sendBatchReq(items);
        })
        this.aggregator.start();
        this.logger.warn(`new Node ${addr}, msgConsumeInterval ${msgConsumeInterval}ms, maxPipeLen ${maxPipeLen}`);
    }

    async sendBatchReq(items) {

        if (this.shouldCheck) {
            try {
                const length = await redis.getLenMQ(this.addr);
                if (length >= MQ_MAX_LEN) {
                    return
                } else if (length <= 50) {
                    this.shouldCheck = false;
                }
            } catch (e) {
                this.logger.error(e);
                return
            }
        }

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
            // this.logger.warn(`before trim ${this.addr}, len ${length}`);
            let curLength = await redis.pushMsgToMQ(this.addr, buffer);
            if (curLength >= MQ_MAX_LEN) {
                const inter = this.aggregator.increaseInterval();
                this.shouldCheck = true;
                await redis.trimMQ(this.addr, MQ_LEN_AFTER_TRIM);
                curLength = await redis.getLenMQ(this.addr);
                this.logger.warn(`trim ${this.addr} done, current len ${curLength}, increase Aggregator interval to ${inter}ms`);
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
