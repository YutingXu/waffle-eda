{ File paths arrive as UTF-16 data from the native macOS picker. }
const
    RequestDirectory = '@DIR@\';

procedure OpenSelection;
var
    Files, Report, Target : TStringList;
    Workspace : IWorkspace;
    Project : IProject;
    Doc : IServerDocument;
    Path, Ext, Kind : String;
    I : Integer;
begin
    Files := TStringList.Create;
    Report := TStringList.Create;
    Target := TStringList.Create;
    try
        Target.LoadFromFile(RequestDirectory + 'window.txt');
        if Trim(Target.Text) <> IntToStr(Client.GetRealMainWindowHandle) then
            Report.Add('The editor window changed. Open the file again.')
        else
        begin
            Files.LoadFromFile(RequestDirectory + 'files.txt');
            Workspace := GetWorkspace;
            for I := 0 to Files.Count - 1 do
            begin
                Path := Files[I];
                Ext := LowerCase(ExtractFileExt(Path));
                try
                    if not FileExists(Path) then Report.Add('Cannot read ' + ExtractFileName(Path))
                    else if (Copy(Ext, 1, 4) = '.prj') or (Ext = '.libpkg') then
                    begin
                        Project := Workspace.DM_OpenProject(Path, True);
                        if Project = Nil then Report.Add('Could not open ' + ExtractFileName(Path));
                    end
                    else if Ext = '.dsnwrk' then
                    begin
                        ResetParameters;
                        AddStringParameter('ObjectKind', 'Workspace');
                        AddStringParameter('FileName', Path);
                        RunProcess('WorkspaceManager:OpenObject');
                    end
                    else
                    begin
                        Doc := Client.GetDocumentByPath(Path);
                        if Doc = Nil then
                        begin
                            if (Ext = '.pcbdoc') or (Ext = '.pcblib') then Client.StartServer('PCB');
                            if (Ext = '.schdoc') or (Ext = '.schlib') then Client.StartServer('SCH');
                            Kind := Client.GetDocumentKindFromDocumentPath(Path);
                            if Kind <> '' then Doc := Client.OpenDocument(Kind, Path);
                            if Doc = Nil then
                            begin
                                { Let Designer's original Open process handle additional formats. }
                                ResetParameters;
                                if Kind <> '' then AddStringParameter('ObjectKind', Kind);
                                AddStringParameter('FileName', Path);
                                RunProcess('WorkspaceManager:OpenObject');
                                Doc := Client.GetDocumentByPath(Path);
                            end;
                        end;
                        if Doc <> Nil then Client.ShowDocument(Doc)
                        else Report.Add('Could not open ' + ExtractFileName(Path));
                    end;
                except
                    Report.Add('Designer could not open ' + ExtractFileName(Path));
                end;
            end;
        end;
        if Report.Count = 0 then Report.Add('OK');
        Report.SaveToFile(RequestDirectory + 'result.tmp');
        RenameFile(RequestDirectory + 'result.tmp', RequestDirectory + 'result.txt');
    finally
        Target.Free;
        Report.Free;
        Files.Free;
    end;
end;
