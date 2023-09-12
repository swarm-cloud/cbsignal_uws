const protobuf = require("protobufjs");
const path = require("path");

let ProtoBuf

function getProtoBuf() {
    return ProtoBuf
}

async function loadProtoFile() {
    const root = await protobuf.load(path.resolve(__dirname, './message.proto'))
    ProtoBuf = root.lookupType("message.SignalBatchReq");
    // console.warn(ProtoBuf);
    // var payload = { items: [{toPeerId: "123"}] };
    // var errMsg = ProtoBuf.verify(payload);
    // if (errMsg) console.error(errMsg)
    // var message = ProtoBuf.create(payload);
    // var buffer = ProtoBuf.encode(message).finish();
    // console.warn(buffer)
    // message = ProtoBuf.decode(buffer);
    // var object = ProtoBuf.toObject(message, {
    //     // longs: String,
    //     // enums: String,
    //     // bytes: String,
    //     // see ConversionOptions
    // });
    // console.warn(object)
    return ProtoBuf
}

module.exports = {
    getProtoBuf,
    loadProtoFile,
}
