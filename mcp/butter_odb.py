"""Publish an approved Butter command through the shared manufacturing translator."""


def invoke(automation, command, args, mode, run):
    receipt = run()
    if mode != "write":
        return receipt
    from automation import ToolError

    result = receipt["untrusted_design_text"]
    publication = result.pop("publication")
    with automation.translated_output("odb", publication["options"], limit="fab_file") as (head, payload):
        if len(head["files"]) != 1:
            raise ToolError("The ODB++ translator must return one archive.", "invalid_result")
        archive = head["files"][0]
        if archive["length"] > publication["maxBytes"]:
            raise ToolError("The ODB++ archive exceeds the Butter output size limit.", "resource_limit")
        folder = automation.output_dir({}, "odb")
        saved = automation.save_file(folder, archive["name"], payload(archive))
    result.update(head["details"], report=head["report"])
    receipt.pop("changes", None)
    return {**receipt, **saved}
