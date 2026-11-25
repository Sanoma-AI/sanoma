---
title: Invoices
description: "Invoice schemas, exact arithmetic, and optional PDF rendering in Node or a browser."
sidebar:
  order: 4
---

Use `sanoma/invoices` for the invoice schema and exact arithmetic. It depends only on Zod. Workflows and site pages can import these functions directly without configuring a connector or storing invoice data.

To generate a PDF, install `@react-pdf/renderer` alongside `sanoma` and import `renderInvoice` from `sanoma/invoices/pdf`. It runs in Node and in the browser. See the [invoice API and examples](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/invoices/README.md).
