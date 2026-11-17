---
title: Invoices
description: "sanoma/invoices is an invoice's shape and exact arithmetic (zod only), and sanoma/invoices/pdf its PDF (renderInvoice, in Node and in a browser)."
sidebar:
  order: 4
---

`sanoma/invoices` is an invoice's shape and exact arithmetic (zod only), and `sanoma/invoices/pdf` its PDF (`renderInvoice`, in Node and in a browser). Both are plain functions a workflow or a site's page imports: no connector, nothing stored. Rendering needs `@react-pdf/renderer` installed beside `sanoma`; a company that never renders needs nothing more. See [`sanoma/invoices`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/invoices/README.md).
