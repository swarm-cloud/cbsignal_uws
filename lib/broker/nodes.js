const Node = require('./node');

class Nodes {
    constructor(selfAddr, logger) {
        this.nodes = new Map();
        this.selfAddr = selfAddr;
        this.logger = logger;
    }

    getNode(addr) {
        return this.nodes.get(addr)
    }

    getTotalNumClient() {
        let sum = 0;
        for (let node of this.nodes.values()) {
            sum += node.numClient;
        }
        return sum
    }

    getNumNode() {
        let sum = 0;
        for (let node of this.nodes.values()) {
            if (node.isAlive) {
                sum += 1;
            }
        }
        return sum
    }

    delete(node) {
        node.destroy();
        this.logger.warn(`nodeHub delete ${node.addr}`);
        this.nodes.delete(node.addr);
    }

    add(addr, node) {
        this.logger.info(`nodeHub add ${addr}`);
        this.nodes.set(addr, node);
    }

    get(addr) {
        let node = this.nodes.get(addr);
        if (!node) {
            this.logger.info(`new Node ${addr}`);
            node = new Node(addr, this.logger);
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
        this.nodes.clear();
    }

}

module.exports = Nodes
