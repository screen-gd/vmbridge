import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon, Link01Icon } from "@hugeicons/core-free-icons";
import type { ClientInfo, CreatedPairing, Overview, PairingLink } from "@vmbridge/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { useAction } from "@/hooks/use-action";
import { ago, api, useTick } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Page, Section } from "./Page.tsx";

export function Devices({ overview }: { overview: Overview }) {
  const now = useTick(15_000);
  const [links, setLinks] = useState<PairingLink[]>([]);
  const manage = useAction();

  const refresh = () => api<PairingLink[]>("/pairing").then(setLinks);
  useEffect(() => void refresh().catch(() => {}), [overview.clients.length]);

  const pending = links.filter((link) => !link.redeemedAt && link.expiresAt > now);

  return (
    <Page title="Devices">
      <Pair onCreated={refresh} />

      <Section title="Paired devices" actions={overview.clients.length > 0 && <Badge variant="secondary">{overview.clients.length}</Badge>}>
        {overview.clients.length === 0 ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} />
              </EmptyMedia>
              <EmptyTitle>No devices yet</EmptyTitle>
              <EmptyDescription>Create a link above and open it in T3 Code.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {overview.clients.map((client) => (
              <Device key={client.id} client={client} now={now} busy={manage.busy} onRemove={() => void manage.run(() => api(`/clients/${client.id}`, { method: "DELETE" }))} />
            ))}
          </ItemGroup>
        )}
        {manage.error && <FieldError>{manage.error}</FieldError>}
      </Section>

      {pending.length > 0 && (
        <Section title="Unused links">
          <ItemGroup className="gap-2">
            {pending.map((link) => (
              <Item key={link.id} variant="outline" size="sm">
                <ItemMedia variant="icon">
                  <HugeiconsIcon icon={Link01Icon} strokeWidth={1.75} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{link.name}</ItemTitle>
                  <ItemDescription>Expires in {Math.max(1, Math.round((link.expiresAt - now) / 60_000))} min</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="ghost" disabled={manage.busy} onClick={() => void manage.run(() => api(`/pairing/${link.id}`, { method: "DELETE" }).then(refresh))}>
                    Cancel
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </Section>
      )}
    </Page>
  );
}

function Pair({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const create = useAction();
  return (
    <Section title="Pair a device">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create.run(async () => {
            setCreated(await api<CreatedPairing>("/pairing", { body: { name } }));
            setName("");
            await onCreated();
          });
        }}
      >
        <Field data-invalid={Boolean(create.error)}>
          <FieldLabel htmlFor="device-name">Device name</FieldLabel>
          <Input id="device-name" className="h-9" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Work laptop" />
          {create.error && <FieldError>{create.error}</FieldError>}
        </Field>
        <div>
          <Button type="submit" size="lg" className="px-4" disabled={create.busy || !name.trim()}>
            Create link
          </Button>
        </div>
      </form>
      {created && (
        <div className="flex flex-col gap-3">
          <FieldDescription>
            Link for <span className="text-foreground">{created.link.name}</span>. Works once, for 15 minutes. In T3 Code, add a remote environment and paste the link from an address the
            device can reach.
          </FieldDescription>
          <ItemGroup className="gap-2">
            {created.urls.map((url) => (
              <Item key={url.url} variant="outline" size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle>{url.label}</ItemTitle>
                  <ItemDescription className="truncate font-mono text-xs">
                    {url.url}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <CopyButton value={url.url} label="Copy link" />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </div>
      )}
    </Section>
  );
}

function Device({ client, now, busy, onRemove }: { client: ClientInfo; now: number; busy: boolean; onRemove: () => void }) {
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={LaptopIcon} strokeWidth={1.75} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          {client.name}
          {client.connected && (
            <Badge variant="secondary" className="gap-1.5">
              <span className="size-1.5 rounded-full bg-success" />
              Connected
            </Badge>
          )}
        </ItemTitle>
        <ItemDescription>
          Paired {ago(client.createdAt, now)}, last seen {ago(client.lastSeenAt, now)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" className="text-destructive" disabled={busy}>
              Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {client.name}?</AlertDialogTitle>
              <AlertDialogDescription>It will need a new link to connect again.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onRemove}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
}
