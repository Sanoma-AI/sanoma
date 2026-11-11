import { resend } from "@sanoma-ai/connector-resend";
import { defineConfig } from "sanoma";

// A company shaped as the invoicing app's: an app's workflow sends an invoice by email with its
// PDF attached, waits a week and reminds; its site starts it and renders a PDF in the page.
export default defineConfig({ connectors: [resend] });
