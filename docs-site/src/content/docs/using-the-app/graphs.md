---
title: "Read a workflow graph"
description: "Trace a run through its operation calls or read the workflow outline before starting it."
sidebar:
  order: 11
---

Open a workflow’s **Graph** to see its possible steps. To see the path a particular run took, open it from **Runs** and select a node to inspect the matching ledger records.

## Run graph

A run's page draws the run as a graph, left to right: the start, each operation call (its effect, the policy's decision, its duration or error), each sleep, each approval the workflow asked for, and how the run ended, or a dashed end while it has not. An approval the policy asked for sits on the call it holds. The calls of one `ctx.all` branch out side by side and join again after it. Each node's colour says how it went: done, failed or denied, waiting on a person or a sleep, or running.

The graph is read from the ledger alone, so it shows what happened, not what the workflow may still do, and it redraws as the page polls. Clicking a node shows it in the inspector, scrolls to its record while the Ledger tab is open, and marks the call in the workflow's source under **Code**: the one the worker placed the call at, which the record names (`node`), when the source still has that call there, so a loop's every pass marks its one call, and a call from a ledger written before calls were placed, or whose file has changed so that another call or none is where it was, marks nothing rather than a guess.

Clicking a call in the source selects its node: of a loop's passes, the latest. A sleep is labelled with the time it ends, in UTC, as the ledger shows times, so the server and every browser draw the same text. It is drawn with [React Flow](https://reactflow.dev) in the browser only; the server renders a placeholder of the same size, the graph's code loads, once, only on the pages that draw a graph (a workflow's and a run's), starting as the page's data loads, and each graph is drawn when it first scrolls near the screen.

A graph pans sideways with the scroll wheel or a drag; its zoom control (React Flow's zoom slider, in the bottom left corner) zooms out and in, shows the zoom (a click sets it back to 100%), and fits the whole graph in view.

A `ctx.all` draws as one lane per member, top to bottom in member order, between the step before it and the step after: in a run that posts to three vendors at once, sleeps, then reads two results at once, the graph shows three lanes, the sleep, then two lanes, each lane coloured as its call went (a call the policy holds waits in its own lane). While a `ctx.all` is the last thing the run has done and the run goes on, each member that has recorded nothing yet has a dashed "not started" lane.

Members that never ran, after one failed, or once the run has moved past the group or ended, have no lane. An operation whose call has a [step name](/workflows/built-ins/#step-names) other than its id says the name, with the id on the line below; a sleep with a name says it the same way, above its clock and the time it ends. A long loop label is cut short in its box; hovering shows it whole.

A call of one of the company's [own operations](/workflows/your-own-operations/#in-the-app) is a box holding the calls its body made, in their order, named by its step with its id, effect and decision along its top, in the operation call's state (active while its body runs). Its outline's box holds the calls the operation's own outline has.

## Outline

Each workflow card on the Workflows page, and a workflow's page, draw the workflow's shape before it runs, from the `outline` that `describeConfig` (`sanoma/workflows/describe`) reads once per workflow when `startApp` starts; the source under a workflow page's Code tab is the workflow's file as it is when the page asks for it.

It is the run graph's drawing without colours: the operations (with their effects), approvals and sleeps the body of `run` calls, a `ctx.all` as lanes, a loop or a `ctx.all` over a list as a box labelled from its code ("for each of subscribers", "repeat while more") (the line into the box goes on inside it to its first nodes, and its last nodes join the line out), an operation or sleep by the name its call gives, and an `if` or `switch` as a diamond that splits into one lane per case, plus a lane marked "otherwise" when the run can go by without any of them (an `if` without `else`, say).

It is a reading of the source, labelled so: "Read from the body of run; the functions it calls are not shown, even those defined in it". When the source cannot be read the card says why instead.
