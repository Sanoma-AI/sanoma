import type { CleaningInput, PetSittingInput } from "./industries.ts";

/** Fictional inputs shared by documentation, previews and integration tests. */
export const petSittingExample = {
  number: "PET-001",
  issuedOn: "2026-10-30",
  dueOn: "2026-11-13",
  currency: "USD",
  issuer: { name: "Clover Pet Care", email: "hello@example.com" },
  recipient: { name: "Alex Morgan" },
  pets: ["Milo", "Luna"],
  services: [
    { service: "visit", quantity: "5", unitPrice: "25" },
    { service: "additional-pet", quantity: "5", unitPrice: "8" },
    { service: "holiday", quantity: "1", unitPrice: "15" },
  ],
} satisfies PetSittingInput;

export const residentialCleaningExample = {
  number: "HOME-001",
  issuedOn: "2026-10-30",
  currency: "USD",
  issuer: { name: "Clover Cleaning" },
  recipient: { name: "Alex Morgan" },
  serviceAddress: { lines: ["10 Example Lane"], city: "Portland", region: "OR" },
  property: "Two-bedroom home",
  services: [
    { service: "deep", quantity: "1", unitPrice: "180" },
    { service: "oven", quantity: "1", unitPrice: "35" },
    { service: "refrigerator", quantity: "1", unitPrice: "25" },
  ],
} satisfies CleaningInput;

export const commercialCleaningExample = {
  number: "OFFICE-001",
  issuedOn: "2026-10-30",
  currency: "USD",
  issuer: { name: "Clover Cleaning" },
  recipient: { name: "Example Company Accounts Payable", address: { lines: ["20 Billing Avenue"], city: "Portland" } },
  serviceAddress: { lines: ["30 Office Street"], city: "Portland" },
  servicePeriod: { start: "2026-10-01", end: "2026-10-30" },
  property: "Office suite",
  services: [
    {
      service: "standard",
      description: "Twice-weekly office cleaning",
      unit: "visit",
      quantity: "8",
      unitPrice: "120",
    },
  ],
} satisfies CleaningInput;
