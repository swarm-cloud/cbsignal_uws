const Node = require('./node');

class Nodes {
    constructor(selfAddr, ProtoBuf, logger) {
        this._map = new Map();
        this.selfAddr = selfAddr;
        this.logger = logger;
        this.ProtoBuf = ProtoBuf;
    }

    getNode(addr) {
        return this.get(addr)
    }

    getTotalNumClient() {
        let sum = 0;
        for (let node of this._map.values()) {
            sum += node.numClient;
        }
        return sum
    }

    getNumNode() {
        let sum = 0;
        for (let node of this._map.values()) {
            if (node.isAlive) {
                sum += 1;
            }
        }
        return sum
    }

    delete(node) {
        node.destroy();
        this.logger.warn(`nodeHub delete ${node.addr}`);
        this._map.delete(node.addr);
    }

    add(addr, node) {
        this.logger.info(`nodeHub add ${addr}`);
        this._map.set(addr, node);
    }

    get(addr) {
        let node = this._map.get(addr);
        if (!node) {
            this.logger.info(`new Node ${addr}`);
            node = new Node(addr, this.ProtoBuf, this.logger);
            this.add(addr, node);
            node.startHeartbeat();
        } else {
            if (node.isDead) {
                this.delete(node);
                return null
            }
        }
        return node
    }

    clear() {
        this.logger.info(`clear nodes`);
        this._map.clear();
    }

}

module.exports = Nodes
