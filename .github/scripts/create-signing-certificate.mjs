import { X509Certificate, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./release-command.mjs";

const vault = process.env.TOR_SIGNING_VAULT ?? "Personal";
const title = "Tor signing secrets";
const items = JSON.parse(run("op", ["item", "list", "--vault", vault, "--format", "json"]));
if (items.some((item) => item.title === title))
  throw new Error(`"${title}" already exists in "${vault}". Nothing was overwritten.`);

const work = mkdtempSync(join(tmpdir(), "tor-code-sign-"));
try {
  const config = join(work, "certificate.cnf");
  const key = join(work, "private.pem");
  const certificate = join(work, "certificate.pem");
  const p12 = join(work, "certificate.p12");
  const openssl = "/usr/bin/openssl";
  const password = randomBytes(32).toString("hex");
  writeFileSync(
    config,
    `
[req]
prompt = no
distinguished_name = subject
x509_extensions = signing
[subject]
CN = Tor Code Signing
[signing]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
`,
    { mode: 0o600 },
  );
  run(
    openssl,
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-days",
      "3650",
      "-nodes",
      "-config",
      config,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // Use the PKCS#12 algorithms understood by macOS security import.
  run(
    openssl,
    [
      "pkcs12",
      "-export",
      "-in",
      certificate,
      "-inkey",
      key,
      "-name",
      "Tor Code Signing",
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1",
      "-passout",
      "stdin",
      "-out",
      p12,
    ],
    { input: `${password}\n`, stdio: ["pipe", "pipe", "inherit"] },
  );
  const fingerprint = new X509Certificate(readFileSync(certificate)).fingerprint256;
  const values = {
    MACOS_CERTIFICATE_P12: readFileSync(p12).toString("base64"),
    MACOS_CERTIFICATE_PASSWORD: password,
  };
  console.log(`Saving Tor's macOS signing certificate in 1Password ("${vault}").`);
  const result = JSON.parse(
    run("/bin/sh", ["-c", 'cat | op item create --vault "$1" --format json -', "sh", vault], {
      input: JSON.stringify({
        title,
        category: "SECURE_NOTE",
        fields: Object.entries(values).map(([label, value]) => ({
          label,
          value,
          type: "CONCEALED",
        })),
      }),
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
  const stored = JSON.parse(
    run("op", ["item", "get", result.id, "--vault", result.vault.id, "--format", "json"]),
  );
  for (const [label, value] of Object.entries(values)) {
    if (!stored.fields.some((field) => field.label === label && field.value === value))
      throw new Error("Could not verify the saved Tor certificate fields");
  }
  console.log(`Stored Tor's certificate in 1Password. SHA-256 fingerprint: ${fingerprint}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
