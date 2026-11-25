{ Builds tests/fixtures/altium/pairs-xsignals/PairsXSignals.PcbDoc from scratch.
  The host substitutes a private C-drive directory for @RUN_DIRECTORY@ and runs
  -RScriptingSystem:RunScriptFile(FileName=...\MakePairsFixture.pas|ProcName=MakePairsFixture)
  in a running Designer. The board is a free document; nothing is added to a project.
  Every step is guarded so a partial result is still saved and reported. }
const
    RunDirectory = '@RUN_DIRECTORY@\';

var
    Log   : TStringList;
    Board : IPCB_Board;
    OX, OY : Integer;

procedure Note(S : String);
begin
    Log.Add(S);
    Log.SaveToFile(RunDirectory + 'progress.txt');
end;

function Mil(V : Double) : Integer;
begin
    Result := MilsToCoord(V);
end;

function MakeNet(Name : String) : IPCB_Net;
begin
    Result := PCBServer.PCBObjectFactory(eNetObject, eNoDimension, eCreate_Default);
    Result.Name := Name;
    Board.AddPCBObject(Result);
end;

function FindNet(Name : String) : IPCB_Net;
var
    It  : IPCB_BoardIterator;
    Net : IPCB_Net;
begin
    Result := Nil;
    It := Board.BoardIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(eNetObject));
        It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll);
        Net := It.FirstPCBObject;
        while Net <> Nil do
        begin
            if Net.Name = Name then
            begin
                Result := Net;
                Break;
            end;
            Net := It.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(It);
    end;
end;

function MakeComponent(Designator, Footprint, Comment : String; X, Y : Double) : IPCB_Component;
begin
    Result := PCBServer.PCBObjectFactory(eComponentObject, eNoDimension, eCreate_Default);
    PCBServer.SendMessageToRobots(Board.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, Result.I_ObjectAddress);
    Result.X := OX + Mil(X);
    Result.Y := OY + Mil(Y);
    Result.Layer := eTopLayer;
    Result.Pattern := Footprint;
    Result.SourceDesignator := Designator;
    Result.Name.Text := Designator;
    Result.Comment.Text := Comment;
end;

function AddPad(Comp : IPCB_Component; PadName, NetName : String; X, Y : Double) : IPCB_Pad;
begin
    Result := PCBServer.PCBObjectFactory(ePadObject, eNoDimension, eCreate_Default);
    Result.Mode := ePadMode_Simple;
    Result.Layer := eTopLayer;
    Result.HoleSize := 0;
    Result.TopShape := eRectangular;
    Result.TopXSize := Mil(40);
    Result.TopYSize := Mil(24);
    Result.X := OX + Mil(X);
    Result.Y := OY + Mil(Y);
    Result.Name := PadName;
    Result.Net := FindNet(NetName);
    Comp.AddPCBObject(Result);
    PCBServer.SendMessageToRobots(Comp.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, Result.I_ObjectAddress);
end;

procedure FinishComponent(Comp : IPCB_Component);
begin
    Board.AddPCBObject(Comp);
    PCBServer.SendMessageToRobots(Board.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, Comp.I_ObjectAddress);
end;

procedure AddTrack(NetName : String; X1, Y1, X2, Y2 : Double);
var
    T : IPCB_Track;
begin
    T := PCBServer.PCBObjectFactory(eTrackObject, eNoDimension, eCreate_Default);
    T.X1 := OX + Mil(X1);
    T.Y1 := OY + Mil(Y1);
    T.X2 := OX + Mil(X2);
    T.Y2 := OY + Mil(Y2);
    T.Width := Mil(8);
    T.Layer := eTopLayer;
    T.Net := FindNet(NetName);
    Board.AddPCBObject(T);
    PCBServer.SendMessageToRobots(Board.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, T.I_ObjectAddress);
end;

function FindPad(Designator, PadName : String) : IPCB_Pad;
var
    It  : IPCB_BoardIterator;
    Pad : IPCB_Pad;
begin
    Result := Nil;
    It := Board.BoardIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(ePadObject));
        It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll);
        Pad := It.FirstPCBObject;
        while Pad <> Nil do
        begin
            if (Pad.Name = PadName) and (Pad.Component <> Nil) then
                if Pad.Component.Name.Text = Designator then
                begin
                    Result := Pad;
                    Break;
                end;
            Pad := It.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(It);
    end;
end;

procedure MakeOutline;
var
    Outline : IPCB_BoardOutline;
    Seg     : TPolySegment;
    I       : Integer;
    XS, YS  : array[0..3] of Double;
begin
    XS[0] := 0;    YS[0] := 0;
    XS[1] := 2000; YS[1] := 0;
    XS[2] := 2000; YS[2] := 1200;
    XS[3] := 0;    YS[3] := 1200;
    Outline := Board.BoardOutline;
    Outline.BeginModify;
    Outline.PointCount := 4;
    for I := 0 to 3 do
    begin
        Seg := TPolySegment;
        Seg.Kind := ePolySegmentLine;
        Seg.vx := OX + Mil(XS[I]);
        Seg.vy := OY + Mil(YS[I]);
        Outline.Segments[I] := Seg;
    end;
    Outline.EndModify;
    Outline.Invalidate;
    Outline.Rebuild;
    Outline.Validate;
end;

procedure MakeNetClass(Name : String; Members : String);
var
    Cls : IPCB_ObjectClass;
    L   : TStringList;
    I   : Integer;
begin
    Cls := PCBServer.PCBClassFactoryByClassMember(eClassMemberKind_Net);
    Cls.SuperClass := False;
    Cls.Name := Name;
    L := TStringList.Create;
    try
        L.CommaText := Members;
        for I := 0 to L.Count - 1 do Cls.AddMemberByName(L[I]);
    finally
        L.Free;
    end;
    Board.AddPCBObject(Cls);
end;

procedure MakeDiffPair(Name, Pos, Neg : String);
var
    DP : IPCB_DifferentialPair;
begin
    DP := PCBServer.PCBObjectFactory(eDifferentialPairObject, eNoDimension, eCreate_Default);
    DP.Name := Name;
    DP.PositiveNet := FindNet(Pos);
    DP.NegativeNet := FindNet(Neg);
    Board.AddPCBObject(DP);
    PCBServer.SendMessageToRobots(Board.I_ObjectAddress, c_Broadcast, PCBM_BoardRegisteration, DP.I_ObjectAddress);
end;

procedure MakeDiffPairClass(Name, Members : String);
var
    Cls : IPCB_ObjectClass;
    L   : TStringList;
    I   : Integer;
begin
    Cls := PCBServer.PCBClassFactoryByClassMember(eClassMemberKind_DifferentialPair);
    Cls.SuperClass := False;
    Cls.Name := Name;
    L := TStringList.Create;
    try
        L.CommaText := Members;
        for I := 0 to L.Count - 1 do Cls.AddMemberByName(L[I]);
    finally
        L.Free;
    end;
    Board.AddPCBObject(Cls);
end;

function MakeXSignal(Name, DesA, PinA, DesB, PinB : String) : IPCB_PinPair;
var
    Pins : IInterfaceList;
    PA, PB : IPCB_Pad;
begin
    Result := Nil;
    PA := FindPad(DesA, PinA);
    PB := FindPad(DesB, PinB);
    if (PA = Nil) or (PB = Nil) then
    begin
        Note('xsignal ' + Name + ': pad lookup failed');
        Exit;
    end;
    Pins := CreateInterfaceList;
    Pins.Add(PA);
    Pins.Add(PB);
    Result := Board.PinPairsManager.CreateFromPins(Pins);
    if Result = Nil then
    begin
        Note('xsignal ' + Name + ': CreateFromPins returned nil');
        Exit;
    end;
    try
        Result.Name := Name;
    except
        Note('xsignal ' + Name + ': Name not writable');
    end;
    Note('xsignal ' + Name + ': created as ' + Result.Name);
end;

procedure MakeRules;
var
    Rule : IPCB_Rule;
begin
    try
        Rule := PCBServer.PCBRuleFactory(eRule_MatchedLengths);
        Rule.Name := 'PCIE_TX_MatchedLength';
        Rule.Scope1Expression := 'InxSignalClass(''PCIE_TX_XSIGNALS'')';
        Rule.Comment := 'Atrium fixture: matched length within xSignal class';
        try Rule.Tolerance := Mil(10); except Note('rule matched-length: no Tolerance'); end;
        Board.AddPCBObject(Rule);
        Note('rule matched-length: ok');
    except
        Note('rule matched-length: FAILED');
    end;
    try
        Rule := PCBServer.PCBRuleFactory(eRule_DifferentialPairsRouting);
        Rule.Name := 'HS_DiffPairs';
        Rule.Scope1Expression := 'InDifferentialPairClass(''HS_PAIRS'')';
        Board.AddPCBObject(Rule);
        Note('rule diffpair-routing: ok');
    except
        Note('rule diffpair-routing: FAILED');
    end;
end;

procedure ReportContents;
var
    It   : IPCB_BoardIterator;
    Obj  : IPCB_Primitive;
    N, I : Integer;
    PP   : IPCB_PinPair;
begin
    It := Board.BoardIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(eClassObject));
        It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll);
        Obj := It.FirstPCBObject;
        while Obj <> Nil do
        begin
            Note('class ' + Obj.Name + ' kind=' + IntToStr(Obj.MemberKind) + ' members=' + IntToStr(Obj.MembersCount));
            Obj := It.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(It);
    end;
    It := Board.BoardIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(eDifferentialPairObject));
        It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll);
        Obj := It.FirstPCBObject;
        while Obj <> Nil do
        begin
            Note('diffpair ' + Obj.Name);
            Obj := It.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(It);
    end;
    N := 0;
    It := Board.BoardIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(ePadObject));
        It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll);
        Obj := It.FirstPCBObject;
        while Obj <> Nil do
        begin
            Inc(N);
            Obj := It.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(It);
    end;
    Note('pads=' + IntToStr(N));
    It := Board.BoardIterator_Create;
    try
        It.AddFilter_ObjectSet(MkSet(eRuleObject));
        It.AddFilter_LayerSet(AllLayers);
        It.AddFilter_Method(eProcessAll);
        Obj := It.FirstPCBObject;
        while Obj <> Nil do
        begin
            if (Obj.Name = 'PCIE_TX_MatchedLength') or (Obj.Name = 'HS_DiffPairs') then
                Note('rule ' + Obj.Name + ' scope=' + Obj.Scope1Expression);
            Obj := It.NextPCBObject;
        end;
    finally
        Board.BoardIterator_Destroy(It);
    end;
    try
        N := Board.PinPairsManager.PinPairsCount;
        Note('xsignals=' + IntToStr(N));
        for I := 0 to N - 1 do
        begin
            PP := Board.PinPairsManager.PinPairs[I];
            Note('xsignal[' + IntToStr(I) + '] ' + PP.Name);
        end;
    except
        Note('xsignal listing FAILED');
    end;
end;

function SaveAs(Doc : IServerDocument; FileName, Kind : String) : Boolean;
begin
    Result := False;
    try
        Result := Doc.DoSafeChangeFileNameAndSave(FileName, Kind);
    except
        Note('save ' + Kind + ': exception');
    end;
    Note('save ' + Kind + ' -> ' + BoolToStr(Result, True) + ' exists=' + BoolToStr(FileExists(FileName), True));
end;

procedure MakePairsFixture;
var
    Doc  : IServerDocument;
    U1, J1, C1, C2, C3 : IPCB_Component;
    PPs  : IInterfaceList;
    PP   : IPCB_PinPair;
begin
    Log := TStringList.Create;
    try
        if PCBServer = Nil then Client.StartServer('PCB');
        Doc := CreateNewFreeDocumentFromDocumentKind('PCB');
        if Doc = Nil then
        begin
            Note('FAILED: no new PCB document');
            Exit;
        end;
        Client.ShowDocument(Doc);
        Board := PCBServer.GetCurrentPCBBoard;
        if Board = Nil then
        begin
            Note('FAILED: no current board');
            Exit;
        end;
        Note('new board ' + Doc.FileName);
        OX := Board.XOrigin;
        OY := Board.YOrigin;

        PCBServer.PreProcess;
        try
            try MakeOutline; Note('outline: ok'); except Note('outline: FAILED'); end;

            try
                MakeNet('USB_DP');      MakeNet('USB_DM');
                MakeNet('PCIE_TX_P');   MakeNet('PCIE_TX_N');
                MakeNet('PCIE_TX_C_P'); MakeNet('PCIE_TX_C_N');
                MakeNet('CLK');         MakeNet('GND');
                MakeNet('+3V3');
                Note('nets: ok');
            except
                Note('nets: FAILED');
            end;

            try
                U1 := MakeComponent('U1', 'ATRIUM_QFN8', 'HOST', 400, 600);
                AddPad(U1, '1', 'USB_DP',    500, 750);
                AddPad(U1, '2', 'USB_DM',    500, 700);
                AddPad(U1, '3', 'PCIE_TX_P', 500, 550);
                AddPad(U1, '4', 'PCIE_TX_N', 500, 500);
                AddPad(U1, '5', 'CLK',       300, 750);
                AddPad(U1, '6', 'GND',       300, 600);
                AddPad(U1, '7', '+3V3',      300, 450);
                FinishComponent(U1);

                J1 := MakeComponent('J1', 'ATRIUM_CONN6', 'EDGE', 1700, 600);
                AddPad(J1, '1', 'USB_DP',      1700, 750);
                AddPad(J1, '2', 'USB_DM',      1700, 700);
                AddPad(J1, '3', 'PCIE_TX_C_P', 1700, 550);
                AddPad(J1, '4', 'PCIE_TX_C_N', 1700, 500);
                AddPad(J1, '5', 'CLK',         1700, 400);
                AddPad(J1, '6', 'GND',         1700, 350);
                FinishComponent(J1);

                C1 := MakeComponent('C1', 'ATRIUM_0402', '100nF', 1100, 550);
                AddPad(C1, '1', 'PCIE_TX_P',   1060, 550);
                AddPad(C1, '2', 'PCIE_TX_C_P', 1140, 550);
                FinishComponent(C1);

                C2 := MakeComponent('C2', 'ATRIUM_0402', '100nF', 1100, 500);
                AddPad(C2, '1', 'PCIE_TX_N',   1060, 500);
                AddPad(C2, '2', 'PCIE_TX_C_N', 1140, 500);
                FinishComponent(C2);

                C3 := MakeComponent('C3', 'ATRIUM_0402', '1uF', 200, 400);
                AddPad(C3, '1', '+3V3', 160, 400);
                AddPad(C3, '2', 'GND',  240, 400);
                FinishComponent(C3);
                Note('components: ok');
            except
                Note('components: FAILED');
            end;

            try
                AddTrack('USB_DP', 500, 750, 1700, 750);
                AddTrack('USB_DM', 500, 700, 1700, 700);
                AddTrack('PCIE_TX_P', 500, 550, 1060, 550);
                AddTrack('PCIE_TX_N', 500, 500, 1060, 500);
                AddTrack('PCIE_TX_C_P', 1140, 550, 1700, 550);
                AddTrack('PCIE_TX_C_N', 1140, 500, 1700, 500);
                Note('tracks: ok');
            except
                Note('tracks: FAILED');
            end;

            try
                MakeNetClass('HS_NETS', 'USB_DP,USB_DM,PCIE_TX_P,PCIE_TX_N,PCIE_TX_C_P,PCIE_TX_C_N');
                MakeNetClass('POWER', 'GND,+3V3');
                Note('net classes: ok');
            except
                Note('net classes: FAILED');
            end;

            try
                MakeDiffPair('USB', 'USB_DP', 'USB_DM');
                MakeDiffPair('PCIE_TX', 'PCIE_TX_P', 'PCIE_TX_N');
                Note('diff pairs: ok');
            except
                Note('diff pairs: FAILED');
            end;

            try
                MakeDiffPairClass('HS_PAIRS', 'USB,PCIE_TX');
                Note('diff pair class: ok');
            except
                Note('diff pair class: FAILED');
            end;
        finally
            PCBServer.PostProcess;
        end;

        { xSignals use the board's pin-pair manager, after the pads are registered. }
        try
            PPs := CreateInterfaceList;
            PP := MakeXSignal('PCIE_TX_P_XS', 'U1', '3', 'J1', '3');
            if PP <> Nil then PPs.Add(PP);
            PP := MakeXSignal('PCIE_TX_N_XS', 'U1', '4', 'J1', '4');
            if PP <> Nil then PPs.Add(PP);
            if PPs.Count > 0 then
            begin
                try
                    Board.PinPairsManager.AssignPinPairClass(PPs, 'PCIE_TX_XSIGNALS');
                    Note('xsignal class PCIE_TX_XSIGNALS: ok');
                except
                    Note('xsignal class PCIE_TX_XSIGNALS: FAILED');
                end;
            end;
            PPs := CreateInterfaceList;
            PP := MakeXSignal('USB_DP_XS', 'U1', '1', 'J1', '1');
            if PP <> Nil then PPs.Add(PP);
            PP := MakeXSignal('USB_DM_XS', 'U1', '2', 'J1', '2');
            if PP <> Nil then PPs.Add(PP);
            if PPs.Count > 0 then
            begin
                try
                    Board.PinPairsManager.AssignPinPairClass(PPs, 'USB_XSIGNALS');
                    Note('xsignal class USB_XSIGNALS: ok');
                except
                    Note('xsignal class USB_XSIGNALS: FAILED');
                end;
            end;
        except
            Note('xsignals: FAILED');
        end;

        PCBServer.PreProcess;
        try
            MakeRules;
        finally
            PCBServer.PostProcess;
        end;

        try ReportContents; except Note('report: FAILED'); end;
        Board.ViewManager_FullUpdate;

        { 'PCB ASCII File' also works, but it writes the legacy 5.01 ASCII format, which
          drops diff pair classes, xSignals and xSignal classes, and it shows a modal
          Information box that blocks this script. Binary only. }
        { Online DRC markers would otherwise be saved as violation streams. }
        try
            ResetParameters;
            RunProcess('PCB:ResetAllErrorMarkers');
            Note('error markers: reset');
        except
            Note('error markers: reset FAILED');
        end;
        SaveAs(Doc, RunDirectory + 'PairsXSignals.PcbDoc', 'PCB 6.0 Binary File');
        Client.CloseDocument(Doc);
        Note('done');
    finally
        Log.SaveToFile(RunDirectory + 'result.tmp');
        RenameFile(RunDirectory + 'result.tmp', RunDirectory + 'result.txt');
        Log.Free;
    end;
end;

{ Reopens the saved board and lists what Designer read back. }
procedure VerifyPairsFixture;
var
    FileName : String;
    Doc      : IServerDocument;
begin
    Log := TStringList.Create;
    try
        FileName := RunDirectory + 'PairsXSignals.PcbDoc';
        if PCBServer = Nil then Client.StartServer('PCB');
        Doc := Client.OpenDocument('PCB', FileName);
        if Doc = Nil then Note('FAILED: could not open ' + FileName)
        else
        begin
            Client.ShowDocument(Doc);
            Board := PCBServer.GetPCBBoardByPath(FileName);
            if Board = Nil then Note('FAILED: board not found')
            else try ReportContents; except Note('report: FAILED'); end;
            Client.CloseDocument(Doc);
        end;
        Note('done');
    finally
        Log.SaveToFile(RunDirectory + 'result.tmp');
        RenameFile(RunDirectory + 'result.tmp', RunDirectory + 'result.txt');
        Log.Free;
    end;
end;
