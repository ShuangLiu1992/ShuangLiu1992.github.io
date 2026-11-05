// Reads VideoFrames off a MediaStreamTrackProcessor and posts them to the page (WebSensorPost.js),
// one at a time: the next frame is read only after the page acks this one ("ack"), so frames never
// pile up on the page and the processor (maxBufferSize 1) drops the stale ones instead.
let looping = true;
let reader_ret;
let ack = null;

async function reader_loop(reader) {
    while (looping) {
        let result = await reader.read();
        if (result.done) {
            return false;
        }
        let frame = result.value;
        const acked = new Promise((resolve) => ack = resolve);
        self.postMessage({type: "frame", frame: frame}, [frame]);
        await acked;
    }
    return true;
}

const release = () => {
    const a = ack;
    ack = null;
    if (a) a();
};

onmessage = async (event) => {
    if (event.data.type === "reader") {
        reader_ret = reader_loop(await event.data.track.getReader());
    }
    if (event.data.type === "ack") {
        release();
    }
    if (event.data.type === "stop") {
        looping = false;
        release();
        await reader_ret;
        self.postMessage({type: "stopped"});
    }
}
