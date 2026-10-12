import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fitDeviceName, maxDeviceNameLen } from "@/crypto/wasm";

/** A code or link to enter, and for a new device the name it will go by. */
export function EnterCodeForm({
  initialCode = "",
  deviceName,
  onDeviceName,
  askName,
  busy,
  onSubmit,
}: {
  initialCode?: string;
  deviceName: string;
  onDeviceName: (name: string) => void;
  /** Whether this browser is a new device, which the holder sees by name. */
  askName: boolean;
  busy: boolean;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState(initialCode);
  const nameOk = !askName || fitDeviceName(deviceName) !== undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!busy && nameOk && code.trim()) onSubmit(code.trim());
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Input
        aria-label="Pairing code"
        placeholder="42-word-word"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="h-9 font-mono"
      />
      {askName && (
        <Input
          aria-label="Device name"
          placeholder="Name of this device"
          maxLength={maxDeviceNameLen()}
          value={deviceName}
          onChange={(e) => onDeviceName(e.target.value)}
          className="h-9"
        />
      )}
      <Button
        type="submit"
        variant="outline"
        disabled={busy || !nameOk || !code.trim()}
      >
        Connect
      </Button>
    </form>
  );
}
