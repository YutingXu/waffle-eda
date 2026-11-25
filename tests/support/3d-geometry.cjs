"use strict";

require("../../app/lazy.js");
for (const file of AtriumLazy.files(["AtriumResolvedGeometry"])) require("../../app/" + file);
