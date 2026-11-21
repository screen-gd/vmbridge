import { copy } from "@/lib/copy";
import { bridgeLatency, routes, vmLatency } from "@/lib/data";
import { cell } from "@/lib/styles";
import { Section } from "./Section";
import { Topology } from "./Topology";

/** The calls each latency figure answers for: bridge-side or VM-side RPC names. */
const callsOf = (kind: "bridge" | "vm") => routes.filter((route) => route.kind === kind).map((route) => route.call);

/** The wiring diagram on top, then the two latency figures with the calls they answer. */
export function Routing() {
  return (
    <Section id="routing" title={copy.routing.title} body={copy.routing.body}>
      <div className="border-b">
        <Topology log={false} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-2">
        <div className={cell}>
          <div className="font-mono text-[2.75rem] leading-none tracking-tight">{bridgeLatency}</div>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">{copy.routing.notes.bridge}</p>
          <div className="mt-5 font-mono text-[13px] leading-7 text-muted-foreground">
            {callsOf("bridge").map((call) => (
              <div key={call}>{call}</div>
            ))}
          </div>
        </div>
        <div className={`${cell} border-t lg:border-t-0 lg:border-l`}>
          <div className="font-mono text-[2.75rem] leading-none tracking-tight text-primary">{vmLatency}</div>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">{copy.routing.notes.vm}</p>
          <div className="mt-5 font-mono text-[13px] leading-7 text-muted-foreground">
            {callsOf("vm").map((call) => (
              <div key={call}>{call}</div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
