import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { InvoiceEditor } from "../../src/ui.ts";
import { commercialCleaningExample, petSittingExample, residentialCleaningExample } from "@sanoma-ai/invoices/examples";
// oxlint-disable-next-line import/no-unassigned-import -- Browser fixture stylesheet.
import "./style.css";

window.invoiceDownloads = [];
const samples = {
  native: { kind: "pet-sitting", initialValue: petSittingExample },
  failed: { kind: "pet-sitting", initialValue: petSittingExample },
  pet: { kind: "pet-sitting", initialValue: petSittingExample },
  home: { kind: "cleaning", initialValue: residentialCleaningExample },
  office: { kind: "cleaning", initialValue: commercialCleaningExample },
  blank: { kind: "pet-sitting" },
  long: {
    kind: "cleaning",
    initialValue: {
      ...commercialCleaningExample,
      services: Array.from({ length: 24 }, (_, i) => ({
        service: "standard",
        description: `Office cleaning visit ${i + 1}`,
        unit: "visit",
        quantity: "1",
        unitPrice: "120",
      })),
    },
  },
};
function Fixture() {
  const [sample, setSample] = useState("pet");
  const [mounted, setMounted] = useState(true);
  return (
    <main>
      <nav aria-label="Test examples">
        {Object.keys(samples).map((key) => (
          <button
            key={key}
            type="button"
            data-example={key}
            onClick={() => {
              setSample(key);
              setMounted(true);
            }}
          >
            {key}
          </button>
        ))}
        <button type="button" data-unmount onClick={() => setMounted(false)}>
          Unmount
        </button>
      </nav>
      <h1>{samples[sample].kind === "pet-sitting" ? "Pet sitting invoice" : "Cleaning invoice"}</h1>
      <p className="intro">Your services and rates, ready for your client.</p>
      {mounted && (
        <InvoiceEditor
          key={sample}
          {...samples[sample]}
          onDownload={
            sample === "native"
              ? undefined
              : (file) => {
                  if (sample === "failed") throw new Error("Test consumer failure");
                  window.invoiceDownloads.push({ ...file, bytes: Array.from(file.bytes) });
                }
          }
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
