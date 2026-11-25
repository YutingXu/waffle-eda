{ Read exported schematic copies in an existing Designer session. The harness
  supplies paths relative to Stage and restores the previous active document. }
const Stage = '@DIR@\';
var
    Report : TStringList;
    Workspace : IWorkspace;
    Project : IProject;
    ProjectPath, GroupName, DocName : String;

procedure Row(Value : String);
begin
    Report.Add(GroupName + '|' + DocName + '|' + Value);
end;

function TextHex(Value : String) : String;
var I : Integer;
begin
    Result := '';
    for I := 1 to Length(Value) do Result := Result + IntToHex(Ord(Value[I]),4);
end;

procedure Capture(Name : String);
var Marker : TStringList; Began : TDateTime;
begin
    Marker := TStringList.Create;
    try
        Marker.Add('ready');
        Marker.SaveToFile(Stage + Name + '.ready');
        Began := Now;
        while (not FileExists(Stage + Name + '.captured')) and ((Now - Began) * 86400 < 3) do
            Client.ApplicationIdle;
    finally
        Marker.Free;
    end;
end;

procedure StartGroup(Name, RelativeProjectPath : String);
var I : Integer; Member : IDocument;
begin
    GroupName := Name;
    DocName := '';
    Project := Nil;
    if RelativeProjectPath = '' then Exit;
    ProjectPath := Stage + RelativeProjectPath;
    Project := Workspace.DM_OpenProject(ProjectPath, True);
    if Project = Nil then Row('failure|open-project')
    else
    begin
        Row('project|' + ExtractFileName(ProjectPath));
        for I := 0 to Project.DM_LogicalDocumentCount - 1 do
        begin
            Member := Project.DM_LogicalDocuments(I);
            Row('member|' + ExtractFileName(Member.DM_FullPath) + '|' + Member.DM_DocumentKind);
        end;
    end;
    Report.SaveToFile(Stage + 'progress.txt');
end;

procedure EndGroup;
var Flat : IDocument; Net : INet; I : Integer;
begin
    DocName := '';
    if Project = Nil then Exit;
    try
        try
            Project.DM_Compile;
            Flat := Project.DM_DocumentFlattened;
            if Flat = Nil then Row('failure|flatten-project')
            else begin
                Row('nets|' + IntToStr(Flat.DM_NetCount));
                for I := 0 to Flat.DM_NetCount - 1 do
                begin
                    Net := Flat.DM_Nets(I);
                    Row('net|' + Net.DM_NetName + '|' + IntToStr(Net.DM_PinCount));
                end;
            end;
        except
            Row('failure|compile-project');
        end;
    finally
        Workspace.DM_CloseProject(ProjectPath);
        Project := Nil;
        Report.SaveToFile(Stage + 'progress.txt');
    end;
end;

procedure ReadKind(Sheet : ISch_Document; Kind : TObjectId; Name : String);
var It : ISch_Iterator; Item : ISch_GraphicalObject; C : ISch_Component;
    Im : ISch_Image; Sym : ISch_SheetSymbol; Port : ISch_Port; N : Integer;
begin
    N := 0;
    It := Sheet.SchIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(Kind));
        Item := It.FirstSchObject;
        while Item <> Nil do
        begin
            Inc(N);
            try
                if Kind = eSchComponent then begin
                    C := Item;
                    Row('component|' + C.Designator.Text + '|' + C.Comment.Text);
                end;
                if (Kind = eLabel) or (Kind = eTextFrame) or (Kind = eNetLabel) then
                    Row('text|' + Name + '|' + TextHex(Item.Text));
                if Kind = ePort then begin
                    Port := Item;
                    Row('port|' + Port.Name);
                end;
                if Kind = eSheetSymbol then begin
                    Sym := Item;
                    Row('child|' + Sym.SchSheetFileName.Text);
                end;
                if Kind = eImage then begin
                    Im := Item;
                    Row('image|' + ExtractFileName(Im.FileName) + '|' + IntToStr(Im.Location.X) + '|' +
                        IntToStr(Im.Location.Y) + '|' + IntToStr(Im.Corner.X) + '|' + IntToStr(Im.Corner.Y));
                    try
                        Im.SaveImageToFile(Stage + GroupName + '-image-' + IntToStr(N) + '.bmp');
                    except
                        Row('failure|extract-native-image');
                    end;
                end;
            except
                Row('failure|read-' + Name);
            end;
            Item := It.NextSchObject;
        end;
        Row('count|' + Name + '|' + IntToStr(N));
    finally
        Sheet.SchIterator_Destroy(It);
    end;
end;

procedure ReadSheet(RelativePath, CaptureName : String);
var Doc : IServerDocument; Sheet : ISch_Document; Path : String;
begin
    Path := Stage + RelativePath;
    DocName := ExtractFileName(Path);
    Doc := Client.OpenDocument(Client.GetDocumentKindFromDocumentPath(Path), Path);
    if Doc = Nil then begin Row('failure|open-sheet'); Exit; end;
    try
        Client.ShowDocument(Doc);
        Client.ApplicationIdle;
        Sheet := SchServer.GetCurrentSchDocument;
        if Sheet = Nil then begin Row('failure|sheet-server'); Exit; end;
        if UpperCase(ExtractFileName(Sheet.DocumentName)) <> UpperCase(DocName) then
        begin Row('failure|active-sheet-mismatch'); Exit; end;
        Row('sheet|' + DocName);
        try
            Row('paper|' + IntToStr(Sheet.SheetSizeX) + '|' + IntToStr(Sheet.SheetSizeY));
        except
            Row('failure|paper');
        end;
        ReadKind(Sheet,eSchComponent,'components');
        ReadKind(Sheet,eWire,'wires');
        ReadKind(Sheet,eNetLabel,'net_labels');
        ReadKind(Sheet,ePowerObject,'power_ports');
        ReadKind(Sheet,eJunction,'junctions');
        ReadKind(Sheet,ePort,'ports');
        ReadKind(Sheet,eSheetSymbol,'sheet_symbols');
        ReadKind(Sheet,eLabel,'labels');
        ReadKind(Sheet,eTextFrame,'text_frames');
        ReadKind(Sheet,eImage,'images');
        Report.SaveToFile(Stage + 'progress.txt');
        if CaptureName <> '' then begin
            Client.SendMessage('Sch:Zoom','Action=All',255,Client.CurrentView);
            Client.ApplicationIdle;
            Capture(CaptureName);
        end;
    finally
        Client.CloseDocument(Doc);
    end;
end;

procedure InspectOutputs;
var Previous : IServerDocument; Target : TStringList;
begin
    Previous := Nil;
    Project := Nil;
    Target := TStringList.Create;
    Report := TStringList.Create;
    try
        Target.LoadFromFile(Stage + 'window.txt');
        if Trim(Target.Text) <> IntToStr(Client.GetRealMainWindowHandle) then Row('failure|editor-changed')
        else begin
            if Client.CurrentView <> Nil then Previous := Client.CurrentView.OwnerDocument;
            Workspace := GetWorkspace;
            Client.StartServer('SCH');
            @CASES@
        end;
    finally
        if Project <> Nil then Workspace.DM_CloseProject(ProjectPath);
        if Previous <> Nil then Client.ShowDocument(Previous);
        Report.SaveToFile(Stage + 'result.tmp');
        RenameFile(Stage + 'result.tmp', Stage + 'result.txt');
        Target.Free;
        Report.Free;
    end;
end;
