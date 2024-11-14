// replace sdp fields key
const FieldReplaceMap = {
    "v=": "V",
    "o=": "O",
    "s=": "S",
    "c=": "C",
    "a=": "A",
    "m=": "M",
    "t=": "T",
};
const FieldReplaceMapReverse =
    Object.fromEntries(Object.entries(FieldReplaceMap).map((a) => a.reverse()));

// replace media attributes
const AttributeRepalceMap = {
    "ice-ufrag:": "U",
    "ice-pwd:": "P",
    // "ice-options:": "O",
    "fingerprint:": "F",
    "candidate:": "C",
    "sctp-port:": "S",
    "max-message-size:": "M",
};
const AttributeRepalceMapReverse =
    Object.fromEntries(
        Object.entries(AttributeRepalceMap).map((a) => a.reverse())
    );

// Replace fingerprint hash function, RFC 8122 section-5
const HashFuncMap = {
    "sha-1": "1",
    "sha-224": "2",
    "sha-256": "3",
    "sha-384": "4",
    "sha-512": "5",
    md5: "6",
    md2: "7",
    token: "8",
};
const HashFuncMapReverse = Object.fromEntries(
    Object.entries(HashFuncMap).map((a) => a.reverse())
);

const protocolEncodeMap = {
    udp: "U",
    UDP: "U",
    tcp: "T",
    TCP: "T",
};

// Candidate encode
const candidateEncodeMap = {
    "typ host generation 0 network-cost 999": "P",
    "rport 0 generation 0 network-cost 999": "W",
    "typ host": "H",
    "typ srflx": "S",
    "rport": "R",
    raddr: "A",
    "0.0.0.0": "V",
    "ufrag": "F",
    "rport 0 generation 0": "G",
    "network-cost": "N",
    "network-id": "E",
    "tcptype active": "C",
    "generation 0": "Q",
};
const candidateEncodeRegex = new RegExp(
    Object.keys(candidateEncodeMap).join("|"),
    "g"
);
const protocolEncodeRegex = new RegExp(
    Object.keys(protocolEncodeMap).join("|"),
    "g"
);
function candidateEncode(line) {
    // 中间的字符串需要拿出来
    const parts = line.split(" ");
    if (parts.length < 5) {
        return line
    }
    const first = parts.slice(0, 4).join(" ");
    const middle = parts[4];
    const second = parts.slice(5).join(" ");
    return `${first.replace(
        protocolEncodeRegex,
        (match) => protocolEncodeMap[match]
    )} ${middle} ${second.replace(
        candidateEncodeRegex,
        (match) => candidateEncodeMap[match]
    )}`;
}

// Candidate decode
const candidateDecodeMap = Object.fromEntries(
    Object.entries({
        ...candidateEncodeMap,
        ...protocolEncodeMap,
    }).map((a) => a.reverse())
);
const candidateDecodeRegex = new RegExp(
    Object.keys(candidateDecodeMap).join("|"),
    "g"
);

function candidateDecode(line) {
    if (line.startsWith("C")) {
        line = "candidate:" + line.slice(1);
    }
    return line.split(" ").map(item => {
        if (item in candidateDecodeMap) {
            item = candidateDecodeMap[item];
        }
        return item
    }).join(" ")
}

// Media encode
const mediaEncodeMap = {
    application: "P",
    "UDP/DTLS/SCTP": "U",
    "webrtc-datachannel": "D",
};
const mediaEncodeRegex = new RegExp(Object.keys(mediaEncodeMap).join("|"), "g");
function mediaEncode(line) {
    return line.replace(mediaEncodeRegex, (match) => mediaEncodeMap[match]);
}

// Media decode
const mediaDecodeMap = Object.fromEntries(
    Object.entries(mediaEncodeMap).map((a) => a.reverse())
);
const mediaDecodeRegex = new RegExp(Object.keys(mediaDecodeMap).join("|"), "g");
function mediaDecode(line) {
    return line.replace(mediaDecodeRegex, (match) => mediaDecodeMap[match]);
}

// Media Connection
const MediaConnectionAddressTypeMap = {
    IP4: "4",
    IP6: "6",
};
const MediaConnectionAddressTypeMapReverse =
    Object.fromEntries(
        Object.entries(MediaConnectionAddressTypeMap).map((a) => a.reverse())
    );
const MediaConnectionIPMap = {
    "0.0.0.0": "0",
};
const MediaConnectionIPMapReverse =
    Object.fromEntries(
        Object.entries(MediaConnectionIPMap).map((a) => a.reverse())
    );

module.exports = {
    FieldReplaceMap,
    FieldReplaceMapReverse,
    AttributeRepalceMap,
    AttributeRepalceMapReverse,
    HashFuncMap,
    MediaConnectionAddressTypeMap,
    MediaConnectionAddressTypeMapReverse,
    MediaConnectionIPMap,
    MediaConnectionIPMapReverse,
    HashFuncMapReverse,
    mediaEncode,
    mediaDecode,
    candidateEncode,
    candidateDecode,
}
