import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { connectWithVariablesMutationOptions } from "@/lib/plugins/mutations";
import type { ConnectVariable } from "@/lib/plugins/queries";

/**
 * The form a plugin server that takes a token asks with: one box per `${VARIABLE}` in its
 * headers, described in the plugin's own words.
 *
 * The values live in this component and in the request that carries them, and nowhere else — the
 * same rule `connection-fields.tsx` keeps for a brokered app's key, for the same reason: a
 * credential we were only asked to forward is not kept legible afterwards. The mutation erases its
 * own copy as the request settles.
 */
export function VariablesDialog({
  open,
  onClose,
  onConnected,
  serverId,
  title,
  variables,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
  serverId: string;
  title: string;
  variables: ConnectVariable[];
}) {
  const queryClient = useQueryClient();
  const form = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const connect = useMutation({
    ...connectWithVariablesMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => {
      setValues({});
      onConnected();
    },
  });

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setValues({});
          setError(null);
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add your {title} key</DialogTitle>
          <DialogDescription>
            Held for you alone, and sent with every call a Bot makes to {title}{" "}
            on your behalf. Nobody else's calls carry it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              connect.mutate({ serverId, values: { ...values } });
            }}
          >
            {variables.map((variable) => (
              <Item key={variable.name} variant="muted">
                <ItemContent>
                  <ItemTitle>
                    <label htmlFor={`${form}-${variable.name}`}>
                      {variable.name}
                    </label>
                  </ItemTitle>
                  {variable.description ? (
                    <ItemDescription className="line-clamp-none">
                      {variable.description}
                    </ItemDescription>
                  ) : null}
                  <Input
                    autoComplete="off"
                    id={`${form}-${variable.name}`}
                    onChange={(event) =>
                      setValues((held) => ({
                        ...held,
                        [variable.name]: event.target.value,
                      }))
                    }
                    required={variable.required}
                    type={variable.writeOnly ? "password" : "text"}
                    value={values[variable.name] ?? ""}
                  />
                </ItemContent>
              </Item>
            ))}
            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            <Button
              className="self-end"
              disabled={connect.isPending}
              size="sm"
              type="submit"
            >
              {connect.isPending ? "Adding…" : "Add key"}
            </Button>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
