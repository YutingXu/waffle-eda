{ The host substitutes the private C-drive directory for this run. }
const
    RunDirectory = '@RUN_DIRECTORY@\';

procedure PublishReport(Report : TStringList);
begin
    Report.SaveToFile(RunDirectory + 'result.tmp');
    RenameFile(RunDirectory + 'result.tmp', RunDirectory + 'result.txt');
end;

procedure CheckEditor;
var
    Report : TStringList;
begin
    Report := TStringList.Create;
    try
        if Client.GetServerModuleByName('ScriptingSystem') <> Nil then Report.Add('scripting=ready');
        if Client.GetServerRecordByName('PCB') <> Nil then Report.Add('pcb=installed');
        PublishReport(Report);
    finally
        Report.Free;
    end;
end;

function CountObjects(Board : IPCB_Board; Kind : TObjectId) : Integer;
var
    Iterator : IPCB_BoardIterator;
    Item     : IPCB_Primitive;
begin
    Result := 0;
    Iterator := Board.BoardIterator_Create;
    try
        Iterator.AddFilter_ObjectSet(MkSet(Kind));
        Iterator.AddFilter_LayerSet(AllLayers);
        Iterator.AddFilter_Method(eProcessAll);
        Item := Iterator.FirstPCBObject;
        while Item <> Nil do
        begin
            Inc(Result);
            Item := Iterator.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(Iterator);
    end;
end;

procedure ReadFixture;
var
    FileName : String;
    Doc      : IServerDocument;
    Board    : IPCB_Board;
    Report   : TStringList;
begin
    FileName := RunDirectory + 'Board.PcbDoc';
    Report := TStringList.Create;
    try
        Doc := Nil;
        if PCBServer = Nil then Client.StartServer('PCB');
        if not FileExists(FileName) then Report.Add('Staged board is missing')
        else if PCBServer = Nil then Report.Add('PCB editor could not start')
        else
        begin
            Doc := Client.OpenDocument('PCB', FileName);
            if Doc = Nil then Report.Add('PCB editor could not open the staged board');
        end;
        if Doc <> Nil then
        begin
            try
                Client.ShowDocument(Doc);
                Board := PCBServer.GetPCBBoardByPath(FileName);
                if Board = Nil then Report.Add('PCB server could not find the opened board')
                else
                begin
                    Report.Add('components=' + IntToStr(CountObjects(Board, eComponentObject)));
                    Report.Add('vias=' + IntToStr(CountObjects(Board, eViaObject)));
                end;
            finally
                Client.CloseDocument(Doc);
            end;
        end;
        PublishReport(Report);
    finally
        Report.Free;
    end;
end;
