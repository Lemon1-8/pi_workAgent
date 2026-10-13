"""Local JSONL subprocess protocol; all paths are supplied by the application."""
import json
import sys

from merge_workflow import prepare_files, preview_workbook, validate_outputs


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    request = json.load(sys.stdin)
    if request["action"] == "check":
        result = prepare_files(request["manifest"], emit)
    elif request["action"] == "preview":
        result = preview_workbook(request["path"], request.get("sheet"), request.get("offset", 0), request.get("limit", 25))
    elif request["action"] == "validate":
        result = validate_outputs(request["paths"], request.get("expectedRecords"), request.get("expectedHeaders"))
    else:
        raise ValueError("未知工作簿操作")
    emit({"type": "result", "data": result})


if __name__ == "__main__":
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
