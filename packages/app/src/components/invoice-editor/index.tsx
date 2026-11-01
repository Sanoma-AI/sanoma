import { useForm, useSelector, type DeepKeysOfType } from "@tanstack/react-form";
import { useEffect, useId, useMemo, useRef, useState, type ComponentProps, type RefObject } from "react";
import {
  cleaningServices,
  currencyPrecision,
  formatMoney,
  InvoiceValidationError,
  petServices,
  type CleaningInput,
  type PetSittingInput,
} from "@sanoma-ai/invoices";
import { pdfLimits, validateLogo, type InvoiceFile } from "@sanoma-ai/invoices/pdf-contract";
import { Button } from "../ui/button.tsx";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "../ui/native-select.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { draftErrors, draftRequest, initialDraft, newService, type Industry, type InvoiceDraft } from "./draft.ts";
import { InvoicePreview, requestKey, type PreviewState } from "./preview.ts";

export type InvoiceEditorProps = (
  | { kind: "pet-sitting"; initialValue?: PetSittingInput }
  | { kind: "cleaning"; initialValue?: CleaningInput }
) & {
  /** Replace the browser download with an explicit caller-provided consumer. */
  onDownload?: (file: InvoiceFile) => void | Promise<void>;
};

/** Stateless local editor, exported through sanoma/ui. Remount to apply new initial data. */
export function InvoiceEditor(props: InvoiceEditorProps) {
  return <Editor key={props.kind} {...props} />;
}

function useInvoiceForm(kind: Industry, defaults: InvoiceDraft, submit: (value: InvoiceDraft) => Promise<void>) {
  return useForm({
    defaultValues: defaults,
    validators: {
      onMount: ({ value }) => draftErrors(kind, value),
      onChange: ({ value }) => draftErrors(kind, value),
      onSubmit: ({ value }) => draftErrors(kind, value),
    },
    onSubmit: ({ value }) => submit(value),
  });
}
type InvoiceForm = ReturnType<typeof useInvoiceForm>;
type TextPath = DeepKeysOfType<InvoiceDraft, string>;

function Editor({ kind, initialValue, onDownload }: InvoiceEditorProps) {
  const id = useId();
  const [defaults] = useState(() => initialDraft(kind, initialValue));
  const nextRow = useRef(defaults.services.length + 1);
  const preview = useRef<InvoicePreview | undefined>(undefined);
  const mounted = useRef(false);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [downloadError, setDownloadError] = useState("");
  const form = useInvoiceForm(kind, defaults, async (value) => {
    setDownloadError("");
    try {
      const request = draftRequest(kind, value);
      if (!preview.current) return;
      const file = await preview.current.obtain(request);
      if (!mounted.current) return;
      if (requestKey(draftRequest(kind, form.state.values)) !== requestKey(request)) {
        setDownloadError("The invoice changed while the PDF was preparing. Download the updated version.");
        return;
      }
      if (onDownload) {
        try {
          await onDownload(file);
        } catch {
          if (mounted.current) setDownloadError("The PDF is ready, but the download did not complete. Try again.");
        }
      } else {
        const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes).buffer], { type: file.mediaType }));
        const link = document.createElement("a");
        link.href = url;
        link.download = file.filename;
        document.body.append(link);
        link.click();
        link.remove();
        downloads.current.set(
          url,
          setTimeout(() => {
            URL.revokeObjectURL(url);
            downloads.current.delete(url);
          }, 60_000),
        );
      }
    } catch (error) {
      if (mounted.current) setDownloadError(renderMessage(error));
    }
  });
  useEffect(() => {
    mounted.current = true;
    const urls = downloads.current;
    return () => {
      mounted.current = false;
      for (const [url, timer] of urls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);
  const text = (name: TextPath, label: string, options: TextOptions = {}) => (
    <TextControl key={name} form={form} name={name} label={label} prefix={id} {...options} />
  );
  const select = (name: TextPath, label: string, options: [string, string][]) => (
    <SelectControl form={form} name={name} label={label} options={options} prefix={id} />
  );
  const address = (prefix: "issuer" | "recipient" | "serviceAddress", section: string) => (
    <>
      {text(`${prefix}.street`, "Street address", {
        multiline: true,
        autoComplete: `section-${section} street-address`,
      })}
      <div className="grid gap-4 sm:grid-cols-2">
        {text(`${prefix}.city`, "City", { autoComplete: `section-${section} address-level2` })}
        {text(`${prefix}.region`, "State / region", { autoComplete: `section-${section} address-level1` })}
        {text(`${prefix}.postalCode`, "Postal code", { autoComplete: `section-${section} postal-code` })}
        {text(`${prefix}.country`, "Country", { autoComplete: `section-${section} country-name` })}
      </div>
    </>
  );

  return (
    <form
      noValidate
      className="mt-8 grid items-start gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="min-w-0 space-y-8">
        <p className="text-sm text-muted-foreground">
          {onDownload
            ? "Download your PDF before leaving this page."
            : "Made in your browser. Nothing is uploaded or saved by this tool. Download your PDF before leaving."}
        </p>
        <FieldSet>
          <FieldLegend className="text-xl">Your business</FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            {text("issuer.name", "Business name", { required: true, autoComplete: "section-issuer organization" })}
            {text("issuer.email", "Business email", { type: "email", autoComplete: "section-issuer email" })}
          </div>
          <details className="space-y-4">
            <summary className="cursor-pointer text-sm underline underline-offset-4">
              Business address and phone (optional)
            </summary>
            {text("issuer.phone", "Business phone", { type: "tel", autoComplete: "section-issuer tel" })}
            {address("issuer", "issuer")}
          </details>
        </FieldSet>
        <FieldSet>
          <FieldLegend className="text-xl">
            {kind === "pet-sitting" ? "Your client and their pets" : "Your client and the property"}
          </FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            {text("recipient.name", kind === "cleaning" ? "Client / company name" : "Client name", {
              required: true,
              autoComplete: "section-recipient name",
            })}
            {text("recipient.email", "Client email", { type: "email", autoComplete: "section-recipient email" })}
          </div>
          {kind === "pet-sitting"
            ? text("pets", "Pet names", { required: true, multiline: true, placeholder: "One pet per line" })
            : text("property", "Property description", {
                placeholder: "For example, a two-bedroom home or office suite",
              })}
          <details className="space-y-4">
            <summary className="cursor-pointer text-sm underline underline-offset-4">
              Billing address and phone (optional)
            </summary>
            {text("recipient.phone", "Client phone", { type: "tel", autoComplete: "section-recipient tel" })}
            {address("recipient", "recipient")}
          </details>
          <details className="space-y-4">
            <summary className="cursor-pointer text-sm underline underline-offset-4">
              Service address (optional)
            </summary>
            <p className="text-sm text-muted-foreground">
              Where the work took place. This can differ from the billing address.
            </p>
            {address("serviceAddress", "service")}
          </details>
        </FieldSet>
        <FieldSet>
          <FieldLegend className="text-xl">Invoice details</FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            {text("number", "Invoice number", { required: true, placeholder: "For example, INV-001" })}
            {select(
              "currency",
              "Currency",
              Object.keys(currencyPrecision).map((code) => [code, code]),
            )}
            {text("issuedOn", "Issue date", { type: "date", required: true })}
            {text("dueOn", "Due date (optional)", { type: "date" })}
          </div>
          <details className="space-y-4">
            <summary className="cursor-pointer text-sm underline underline-offset-4">Service period (optional)</summary>
            <div className="grid gap-4 sm:grid-cols-2">
              {text("periodStart", "Service period start", { type: "date" })}
              {text("periodEnd", "Service period end", { type: "date" })}
            </div>
          </details>
        </FieldSet>
        <FieldSet>
          <FieldLegend className="text-xl">
            {kind === "pet-sitting" ? "Visits and care" : "Cleaning services"}
          </FieldLegend>
          <form.Field name="services" mode="array">
            {(field) => (
              <>
                <div className="space-y-5">
                  {field.state.value.map((line, index) => (
                    <div key={line.id} className="space-y-3 rounded-xl border border-border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium">Service {index + 1}</p>
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11"
                          aria-label={`Remove service ${index + 1}`}
                          disabled={field.state.value.length === 1}
                          onClick={() => field.removeValue(index)}
                        >
                          Remove
                        </Button>
                      </div>
                      {select(
                        `services[${index}].service`,
                        "Service",
                        kind === "pet-sitting"
                          ? Object.entries(petServices).map(([key, value]) => [key, value.label])
                          : Object.entries(cleaningServices),
                      )}
                      <div className="grid grid-cols-2 gap-4">
                        {text(`services[${index}].quantity`, kind === "pet-sitting" ? "Quantity" : "Quantity / hours", {
                          inputMode: "decimal",
                          required: true,
                        })}
                        {text(`services[${index}].unitPrice`, "Price per unit", {
                          inputMode: "decimal",
                          required: true,
                          placeholder: "0.00",
                        })}
                      </div>
                      {kind === "cleaning" &&
                        select(`services[${index}].unit`, "Unit", [
                          ["job", "Job"],
                          ["hour", "Hour"],
                          ["visit", "Visit"],
                        ])}
                      <details className="space-y-3">
                        <summary className="cursor-pointer text-sm underline underline-offset-4">
                          Description and date (optional)
                        </summary>
                        {text(`services[${index}].description`, "Service description", {
                          multiline: true,
                          placeholder: "Leave blank to use the service name",
                        })}
                        {text(`services[${index}].serviceDate`, "Service date", { type: "date" })}
                      </details>
                    </div>
                  ))}
                </div>
                {field.state.meta.errors.length > 0 && (
                  <FieldError>{field.state.meta.errors.filter(Boolean).map(String).join(". ")}</FieldError>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start px-4 text-sm"
                  disabled={field.state.value.length >= pdfLimits.lines}
                  onClick={() => field.pushValue(newService(kind, nextRow.current++))}
                >
                  Add a service
                </Button>
              </>
            )}
          </form.Field>
        </FieldSet>
        <details className="space-y-4">
          <summary className="cursor-pointer text-base font-medium">Discount, tax and payments</summary>
          <div className="grid gap-4 sm:grid-cols-3">
            {text("discount", "Discount amount", { inputMode: "decimal" })}
            {text("taxPercent", "Tax (%)", { inputMode: "decimal" })}
            {text("paid", "Already paid", { inputMode: "decimal" })}
          </div>
        </details>
        {text("notes", "Notes (optional)", {
          multiline: true,
          placeholder: "Payment instructions or a short thank-you",
        })}
        <details className="space-y-4">
          <summary className="cursor-pointer text-base font-medium">PDF appearance</summary>
          <div className="grid gap-4 sm:grid-cols-2">
            {select("paper", "Paper size", [
              ["A4", "A4"],
              ["LETTER", "US Letter"],
            ])}
            {select("locale", "Number format", [
              ["en-US", "English (US)"],
              ["en-GB", "English (UK)"],
              ["de-DE", "German"],
              ["fr-FR", "French"],
            ])}
            {text("accent", "Accent color", { type: "color" })}
          </div>
          <LogoControl form={form} prefix={id} />
        </details>
      </div>
      <PreviewPane form={form} kind={kind} session={preview} downloadError={downloadError} />
    </form>
  );
}

interface TextOptions {
  type?: ComponentProps<"input">["type"];
  inputMode?: ComponentProps<"input">["inputMode"];
  autoComplete?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
}
function TextControl({
  form,
  name,
  label,
  prefix,
  multiline,
  ...options
}: TextOptions & { form: InvoiceForm; name: TextPath; label: string; prefix: string }) {
  return (
    <form.Field name={name}>
      {(field) => {
        const errors = field.state.meta.isTouched ? field.state.meta.errors.filter(Boolean).map(String) : [];
        const id = `${prefix}-${name}`;
        const props = {
          id,
          name,
          value: field.state.value,
          onBlur: field.handleBlur,
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            field.handleChange(event.target.value),
          "aria-invalid": errors.length > 0,
          "aria-describedby": errors.length ? `${id}-error` : undefined,
          autoComplete: options.autoComplete ?? "off",
          placeholder: options.placeholder,
          required: options.required,
        };
        return (
          <Field data-invalid={errors.length > 0}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {multiline ? (
              <Textarea {...props} className="min-h-20 text-base md:text-base" rows={2} />
            ) : (
              <Input
                {...props}
                type={options.type ?? "text"}
                inputMode={options.inputMode}
                className="h-11 text-base md:text-base"
              />
            )}
            {errors.length > 0 && <FieldError id={`${id}-error`}>{errors.join(". ")}</FieldError>}
          </Field>
        );
      }}
    </form.Field>
  );
}

function SelectControl({
  form,
  name,
  label,
  options,
  prefix,
}: {
  form: InvoiceForm;
  name: TextPath;
  label: string;
  options: [string, string][];
  prefix: string;
}) {
  return (
    <form.Field name={name}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={`${prefix}-${name}`}>{label}</FieldLabel>
          <NativeSelect
            id={`${prefix}-${name}`}
            name={name}
            className="w-full [&_select]:h-11 [&_select]:text-base"
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            onBlur={field.handleBlur}
          >
            {options.map(([value, text]) => (
              <NativeSelectOption value={value} key={value}>
                {text}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
    </form.Field>
  );
}

function LogoControl({ form, prefix }: { form: InvoiceForm; prefix: string }) {
  const sequence = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const logo = useSelector(form.store, (state) => state.values.logo);
  const error = useSelector(form.store, (state) => state.values.logoError);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  return (
    <Field>
      <FieldLabel htmlFor={`${prefix}-logo`}>Business logo (optional)</FieldLabel>
      <Input
        ref={input}
        id={`${prefix}-logo`}
        name="logo"
        type="file"
        accept="image/png"
        className="h-11 text-base md:text-base"
        aria-invalid={Boolean(error)}
        aria-describedby={`${prefix}-logo-help`}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          const revision = ++sequence.current;
          if (!file) return;
          form.setFieldValue("logoError", "Reading the logo…");
          try {
            if (file.size > pdfLimits.logoBytes) throw new Error("Use a PNG logo under 256 KiB.");
            if (file.type && file.type !== "image/png") throw new Error("Use a PNG image for the logo.");
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const data = validateLogo(btoa(binary));
            if (revision !== sequence.current) return;
            form.setFieldValue("logo", { mediaType: "image/png", base64: data.slice(data.indexOf(",") + 1) });
            form.setFieldValue("logoError", "");
          } catch (failure) {
            if (revision !== sequence.current) return;
            form.setFieldValue(
              "logoError",
              failure instanceof InvoiceValidationError
                ? (failure.issues[0]?.message ?? "Use a supported PNG logo.")
                : "Use a PNG logo under 256 KiB and at most 1024 pixels per side.",
            );
          }
        }}
      />
      <p id={`${prefix}-logo-help`} className="text-sm text-muted-foreground">
        PNG, up to 256 KiB and 1024 pixels per side. Images stay in this page.
      </p>
      {error && <FieldError>{error}</FieldError>}
      {(logo || error) && (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          onClick={() => {
            sequence.current++;
            form.setFieldValue("logo", undefined);
            form.setFieldValue("logoError", "");
            if (input.current) input.current.value = "";
          }}
        >
          Remove logo
        </Button>
      )}
    </Field>
  );
}

function renderMessage(error: unknown) {
  if (error instanceof InvoiceValidationError)
    return error.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(". ");
  return "The PDF could not be prepared. Check your invoice and logo, then try downloading again.";
}

function PreviewPane({
  form,
  kind,
  session,
  downloadError,
}: {
  form: InvoiceForm;
  kind: Industry;
  session: RefObject<InvoicePreview | undefined>;
  downloadError: string;
}) {
  const values = useSelector(form.store, (state) => state.values);
  const request = useMemo(() => {
    try {
      return draftRequest(kind, values);
    } catch {
      return undefined;
    }
  }, [kind, values]);
  const [state, setState] = useState<PreviewState>({ status: "empty" });
  const [url, setUrl] = useState<string>();
  const [viewer, setViewer] = useState(true);
  useEffect(() => {
    const current = new InvoicePreview(setState);
    session.current = current;
    setViewer(navigator.pdfViewerEnabled !== false);
    return () => {
      current.close();
      if (session.current === current) session.current = undefined;
    };
  }, [session]);
  useEffect(() => {
    session.current?.update(request);
  }, [request, session]);
  useEffect(() => {
    if (!state.file) return;
    const next = URL.createObjectURL(
      new Blob([new Uint8Array(state.file.bytes).buffer], { type: state.file.mediaType }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [state.file]);
  const current = request && state.key === requestKey(request);
  return (
    <aside className="min-w-0 space-y-4 lg:sticky lg:top-6" aria-label="Invoice PDF preview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium">Your invoice</h2>
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {state.status === "updating"
              ? "Updating PDF…"
              : state.status === "ready"
                ? "PDF is up to date"
                : state.status === "error"
                  ? "Preview needs attention"
                  : state.file
                    ? "Complete the fields to update this preview"
                    : "Complete the required fields to preview your PDF"}
          </p>
        </div>
        <form.Subscribe selector={(formState) => [formState.canSubmit, formState.isSubmitting] as const}>
          {([canSubmit, submitting]) => (
            <Button type="submit" className="min-h-11 px-5 text-sm" disabled={!canSubmit || submitting}>
              {submitting ? "Preparing PDF…" : "Download PDF"}
            </Button>
          )}
        </form.Subscribe>
      </div>
      {Boolean(downloadError || state.error) && <FieldError>{downloadError || renderMessage(state.error)}</FieldError>}
      {state.file && state.status === "ready" && current && (
        <p className="text-sm">
          Balance due{" "}
          <strong>{formatMoney(state.file.summary.dueMinor, request.invoice.currency, request.invoice.locale)}</strong>
        </p>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-muted/30">
        {url && viewer ? (
          <object
            data={`${url}#toolbar=0&view=FitH`}
            type="application/pdf"
            aria-label="Generated invoice PDF"
            className="block h-[min(78vh,860px)] min-h-96 w-full"
          >
            <p className="p-6">Your browser cannot show this preview. Use Download PDF to open the complete invoice.</p>
          </object>
        ) : (
          <div className="flex min-h-96 flex-col items-center justify-center gap-4 px-8 py-12 text-center">
            <div className="flex h-40 w-28 flex-col gap-3 rounded border border-border bg-card p-5" aria-hidden="true">
              <div className="h-2 w-12 bg-primary/60" />
              <div className="mt-4 h-1 w-full bg-border" />
              <div className="h-1 w-full bg-border" />
              <div className="h-1 w-8 bg-border" />
            </div>
            <p className="max-w-64 text-muted-foreground">
              {url
                ? "Your PDF is ready. Use Download PDF to open it in your viewer."
                : "Your services, details and totals will appear here as a complete PDF."}
            </p>
          </div>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        The preview uses the same PDF you download. Longer invoices continue across pages.
      </p>
    </aside>
  );
}
