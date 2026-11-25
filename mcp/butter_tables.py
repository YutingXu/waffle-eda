"""Read a bounded HTML table as inert cell data for the shared table importer."""
from html.parser import HTMLParser
import re

LIMIT = 8192
MAX_BYTES = 2 * 1024 * 1024
COLOR = re.compile(r"#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})\Z")
CLASS_SELECTOR = re.compile(r"(?:td|th)?\.([A-Za-z_][\w-]{0,63})\Z")


def declarations(css):
    for declaration in css.split(";"):
        key, colon, value = declaration.partition(":")
        key, value = key.strip().lower(), value.strip().lower()
        if colon and 0 < len(value) <= 128:
            yield key, value


def style_record(values, bold, italic, header):
    result = {}
    weight = values.get("font-weight", "")
    if header or bold or weight == "bold" or weight.isdecimal() and int(weight) >= 600:
        result["bold"] = True
    if italic or values.get("font-style") == "italic":
        result["italic"] = True
    if values.get("white-space") in ("normal", "pre-wrap"):
        result["wrap"] = True
    for key, attr, allowed in (
        ("align", "text-align", ("left", "center", "right")),
        ("vertical", "vertical-align", ("top", "middle", "bottom")),
    ):
        if values.get(attr) in allowed:
            result[key] = values[attr]
    for key, attr in (("color", "color"), ("fill", "background-color")):
        if COLOR.fullmatch(values.get(attr, "")):
            result[key] = values[attr]
    borders = {}
    for edge in ("top", "right", "bottom", "left"):
        rule = values.get(f"border-{edge}", values.get("border", ""))
        stroke = values.get(f"border-{edge}-style", values.get("border-style", ""))
        if stroke in ("solid", "dashed", "dotted", "double") or any(
            word in rule.split() for word in ("solid", "dashed", "dotted", "double")
        ):
            color = values.get(f"border-{edge}-color", values.get("border-color", ""))
            if not color:
                color = next((word for word in rule.split() if COLOR.fullmatch(word)), "")
            borders[edge] = color if COLOR.fullmatch(color) else "line"
    if borders:
        result["borders"] = borders
    return result


class TableReader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = self.hidden = self.cells = 0
        self.started = self.finished = self.heading = self.stylesheet = False
        self.css = []
        self.rows, self.merges, self.occupied = [], [], set()
        self.row = self.cell = None

    def handle_starttag(self, tag, pairs):
        if tag == "style":
            self.stylesheet = True
            return
        if tag in ("script", "template", "iframe", "object"):
            self.hidden += 1
            return
        if self.hidden:
            return
        if tag == "table" and not self.finished:
            self.started = True
            self.depth += 1
        if self.depth != 1 or self.finished:
            return
        if tag == "thead":
            self.heading = True
        if tag == "tr":
            self.finish_row()
            if len(self.rows) >= LIMIT:
                raise ValueError("The pasted table has too many rows.")
            self.row = []
        if tag in ("td", "th") and self.row is not None:
            self.finish_cell()
            attrs = {key: value for key, value in pairs if value is not None}
            row, column = len(self.rows), len(self.row)
            while (row, column) in self.occupied:
                column += 1
            try:
                rs, cs = int(attrs.get("rowspan", "1")), int(attrs.get("colspan", "1"))
            except ValueError:
                raise ValueError("Choose valid HTML table spans.") from None
            self.cells += rs * cs
            if not 0 < rs <= LIMIT - row or not 0 < cs <= 256 - column or self.cells > LIMIT:
                raise ValueError("Select a smaller rectangular paste region.")
            for r in range(row, row + rs):
                for c in range(column, column + cs):
                    if (r, c) in self.occupied:
                        raise ValueError("The clipboard contains overlapping cells.")
                    self.occupied.add((r, c))
            if rs * cs > 1:
                self.merges.append(dict(r=row, c=column, rows=rs, columns=cs))
            self.row.extend([None] * (column - len(self.row)))
            self.cell = dict(header=tag == "th", scope=attrs.get("scope", ""), heading=self.heading,
                             parts=[], inline=[attrs.get("style", "")], classes=attrs.get("class", "").split(),
                             bold=False, italic=False, attrs=attrs)
        if self.cell is None:
            return
        if tag == "br":
            self.cell["parts"].append("\n")
        if tag in ("b", "strong"):
            self.cell["bold"] = True
        if tag in ("i", "em"):
            self.cell["italic"] = True
        if tag == "span" and len(self.cell["inline"]) == 1:
            self.cell["inline"].append(next((value or "" for key,value in pairs if key=="style"), ""))

    def handle_endtag(self, tag):
        if tag == "style":
            self.stylesheet = False
            return
        if tag in ("script", "template", "iframe", "object"):
            self.hidden = max(0, self.hidden - 1)
            return
        if self.hidden:
            return
        if self.depth == 1:
            if tag in ("td", "th"):
                self.finish_cell()
            if tag in ("tr", "table"):
                self.finish_row()
            if tag == "thead":
                self.heading = False
        if self.depth and tag == "table":
            self.depth -= 1
            self.finished = self.depth == 0

    def handle_data(self, data):
        if self.stylesheet:
            self.css.append(data)
        elif self.depth == 1 and self.cell is not None and not self.hidden:
            self.cell["parts"].append(data)

    def finish_cell(self):
        if self.cell is not None:
            self.row.append(self.cell)
            self.cell = None

    def finish_row(self):
        self.finish_cell()
        if self.row is not None:
            self.rows.append(self.row)
            self.row = None

    def result(self):
        self.finish_row()
        if not self.started or not self.rows:
            raise ValueError("Choose an HTML document containing a table.")
        rules = {}
        for rule in re.finditer(r"([^{}]+)\{([^{}]*)\}", "".join(self.css)):
            for selector in rule[1].split(","):
                match = CLASS_SELECTOR.fullmatch(selector.strip())
                if match and len(rules) < 1024:
                    rules.setdefault(match[1], {}).update(declarations(rule[2]))
        for row in self.rows:
            for cell in row:
                if cell is None:
                    continue
                attrs = cell.pop("attrs")
                style = {"background-color": attrs.get("bgcolor", ""), "text-align": attrs.get("align", "")}
                for name in cell.pop("classes"):
                    style.update(rules.get(name, {}))
                for css in cell.pop("inline"):
                    style.update(declarations(css))
                cell["style"] = style_record(style,cell.pop("bold"),cell.pop("italic"),cell["header"])
                cell["text"] = "".join(cell.pop("parts"))
        return {"rows":self.rows, "merges":self.merges,
                "notice":"Pasted values. Spreadsheet formulas are imported as their displayed values."}


def invoke(automation, local_id, args, mode, run):
    if local_id in ("bind-query", "refresh-query"):
        from board_runner import MODULES

        requested = local_id == "refresh-query" or "savedQueryId" in args
        if requested and "query" in automation.butter_enabled and "butter-query-service" in MODULES:
            return run(modules=("butter-query-service",))
        return run()
    if local_id != "import" or args["format"] != "html":
        return run()
    from automation import ToolError

    source = args["data"]
    if len(source.encode("utf-8")) > MAX_BYTES:
        raise ToolError("The pasted table exceeds 2 MiB.", "resource_limit")
    try:
        reader = TableReader()
        reader.feed(source)
        reader.close()
        parsed = reader.result()
    except ValueError as error:
        raise ToolError(str(error), "invalid_arguments") from None
    return run(native={"tableImport":parsed})
