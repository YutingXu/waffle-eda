"use strict";

// Load the native query compiler and the classic-scope translator in dependency order.
globalThis.AtriumDesignQueryWorkerModules = Object.freeze((/** @type {[string, string][]} */ ([
  ["AtriumDesignQueryRecord", "../checks/design-query-record.js"],
  ["AtriumCalculationIntent", "../notebook/calculation-intent.js"],
  ["AtriumCalculationCore", "../notebook/calculation-core.js"],
  ["AtriumNoteFields", "../notebook/note-fields.js"],
  ["AtriumQueryFields", "../checks/query-fields.js"],
  ["AtriumDesignQueryParser", "../checks/design-query-parser.js"],
  ["AtriumDesignQueryGeometry", "../checks/design-query-geometry.js"],
  ["AtriumDesignQueryContext", "../checks/design-query-context.js"],
  ["AtriumDesignQueryIndex", "../checks/design-query-index.js"],
  ["AtriumDesignQuery", "../checks/design-query.js"],
  ["AtriumQueryExchange", "../checks/query-exchange.js"]
])).map(entry => Object.freeze(entry)));
