import { copy } from "@/lib/copy";
import { bridgeLatency, routes, vmLatency } from "@/lib/data";
import { cell } from "@/lib/styles";
import { Section } from "./Section";
import { Panel } from "./Window";

/** Which calls the bridge answers itself and which it forwards to a VM, with the measured gap beside it. */
export function Routing() {
  return (
    <Section id="routing" title={copy.routing.title} body={copy.routing.body}>
      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Panel label="vmbridge.log">
            <table className="hidden w-full font-mono text-[12.5px] sm:table">
              <thead>
                <tr>
                  <th className="px-4 py-2.5 text-left font-normal text-faint">{copy.routing.columns.call}</th>
                  <th className="px-4 py-2.5 text-left font-normal text-faint">{copy.routing.columns.target}</th>
                  <th className="px-4 py-2.5 text-right font-normal text-faint">{copy.routing.columns.time}</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr key={route.call} className="border-t">
                    <td className="px-4 py-2.5">{route.call}</td>
                    <td className={`px-4 py-2.5 ${route.kind === "vm" ? "text-primary" : "text-foreground"}`}>{route.target}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{route.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sm:hidden">
              {routes.map((route) => (
                <div key={route.call} className="border-t px-4 py-3 font-mono text-[12.5px] first:border-t-0">
                  <div className="break-all">{route.call}</div>
                  <div className="mt-1 flex justify-between">
                    <span className={route.kind === "vm" ? "text-primary" : "text-foreground"}>{route.target}</span>
                    <span className="tabular-nums text-muted-foreground">{route.time}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="flex flex-col border-t lg:col-span-5 lg:border-t-0 lg:border-l">
          <div className={`${cell} flex-1 border-b`}>
            <div className="font-mono text-[2rem] leading-none tracking-tight">{bridgeLatency}</div>
            <p className="mt-3 text-sm text-muted-foreground">{copy.routing.notes.bridge}</p>
          </div>
          <div className={`${cell} flex-1`}>
            <div className="font-mono text-[2rem] leading-none tracking-tight text-primary">{vmLatency}</div>
            <p className="mt-3 text-sm text-muted-foreground">{copy.routing.notes.vm}</p>
          </div>
        </div>
      </div>
    </Section>
  );
}
