// shield.js runs in the page's own world (it has to see the page's clicks first), but only the
// isolated world may talk to the background. The two worlds share the DOM, so they meet on events.
//
// A secret is agreed before any page script exists (document_start scripts of both worlds run
// before the page's), whichever world starts first:
//   main:     "cineon-shield-hello" (detail: nonce), and answers one "cineon-shield-ask"
//   isolated: "cineon-shield-ask", takes the first hello, then "cineon-shield-ack"
// After that, shield.js's reports are events named "cineon-shield-<nonce>": a page can't listen for
// a name it doesn't know (window.postMessage would hand the nonce to every page listener), and the
// main world dispatches through the original dispatchEvent, captured before the page could wrap it.

const HELLO = "cineon-shield-hello";
const ASK = "cineon-shield-ask";
const ACK = "cineon-shield-ack";

/** The page-world side: gives shield.js its `cineonShield` handler. */
export function installMainRelay(doc: Document = document, makeNonce: () => string = randomNonce): (body: unknown) => void {
  const dispatch = EventTarget.prototype.dispatchEvent;
  const Custom = CustomEvent;
  const nonce = makeNonce();
  let acknowledged = false;
  const hello = () => {
    if (!acknowledged) dispatch.call(doc, new Custom(HELLO, { detail: nonce }));
  };
  const onAsk = () => hello();
  const onAck = () => {
    acknowledged = true;
    doc.removeEventListener(ASK, onAsk);
    doc.removeEventListener(ACK, onAck);
  };
  doc.addEventListener(ASK, onAsk);
  doc.addEventListener(ACK, onAck);
  hello();
  const name = `cineon-shield-${nonce}`;
  return (body) => {
    try {
      dispatch.call(doc, new Custom(name, { detail: JSON.stringify(body ?? null) }));
    } catch {
      // The page may have broken the DOM; a lost report only costs a count.
    }
  };
}

/** The isolated side: hears shield.js's reports and passes them on. */
export function installIsolatedRelay(doc: Document, deliver: (body: unknown) => void): void {
  let nonce: string | null = null;
  const onHello = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (nonce != null || typeof detail !== "string" || detail.length < 16) return;
    nonce = detail;
    doc.removeEventListener(HELLO, onHello);
    doc.addEventListener(`cineon-shield-${nonce}`, (report) => {
      const text = (report as CustomEvent).detail;
      if (typeof text !== "string") return;
      try {
        deliver(JSON.parse(text));
      } catch {
        // Not ours.
      }
    });
    doc.dispatchEvent(new CustomEvent(ACK));
  };
  doc.addEventListener(HELLO, onHello);
  doc.dispatchEvent(new CustomEvent(ASK));
}

function randomNonce(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
