{ Run WriteActivePCBReport in Altium Designer with a disposable PCB open.
  Coordinates use native ticks (one tick is 0.00000254 mm).
  Each body row reports the actual model type, basename and payload size.
  Type 0 is an extruded body and type 1 is a STEP model in Designer 26.12.2.9. }

procedure InspectKind(Board : IPCB_Board; Kind : TObjectId; LabelText : String; Report : TStringList);
var
    Objects : IPCB_BoardIterator;
    Item : IPCB_Primitive;
    Arc : IPCB_Arc;
    Body : IPCB_ComponentBody;
    Model : IPCB_Model;
    Rule : IPCB_Rule;
    Polygon : IPCB_Polygon;
    Region : IPCB_Region;
    Bounds : TCoordRect;
    OwnerName : String;
    Total : Integer;
begin
    Total := 0;
    Objects := Board.BoardIterator_Create;
    try
        Objects.AddFilter_ObjectSet(MkSet(Kind));
        Objects.AddFilter_LayerSet(AllLayers);
        Objects.AddFilter_Method(eProcessAll);
        Item := Objects.FirstPCBObject;
        while Item <> Nil do
        begin
            Inc(Total);
            if Kind = eArcObject then
            begin
                Arc := Item;
                Report.Add('arc|' + IntToStr(Arc.Layer) + '|' + IntToStr(Arc.XCenter) + '|' +
                           IntToStr(Arc.YCenter) + '|' + IntToStr(Arc.Radius) + '|' +
                           FloatToStr(Arc.StartAngle) + '|' + FloatToStr(Arc.EndAngle));
            end;
            if Kind = ePolyObject then
            begin
                Polygon := Item;
                Report.Add('polygon|' + Polygon.Name + '|' + IntToStr(Polygon.Layer) + '|' +
                           IntToStr(Polygon.PourIndex) + '|' + IntToStr(Polygon.PourOver) + '|' +
                           IntToStr(Polygon.Grid) + '|' + IntToStr(Polygon.TrackSize));
            end;
            if Kind = eRegionObject then
            begin
                Region := Item;
                OwnerName := '';
                if Item.Polygon <> Nil then OwnerName := Item.Polygon.Name;
                Bounds := Item.BoundingRectangle;
                Report.Add('region|' + OwnerName + '|' + IntToStr(Region.Kind) + '|' +
                           IntToStr(Item.Layer) + '|' + IntToStr(Region.HoleCount) + '|' +
                           IntToStr(Bounds.Left) + '|' + IntToStr(Bounds.Bottom) + '|' +
                           IntToStr(Bounds.Right) + '|' + IntToStr(Bounds.Top));
            end;
            if Kind = eRuleObject then
            begin
                Rule := Item;
                Report.Add('rule|' + Rule.Name + '|' + IntToStr(Rule.RuleKind) + '|' +
                           IntToStr(Rule.Priority) + '|' + BoolToStr(Rule.DRCEnabled, True) + '|' +
                           Rule.Scope1Expression + '|' + Rule.Scope2Expression);
            end;
            if Kind = eComponentBodyObject then
            begin
                Body := Item;
                OwnerName := '';
                if Body.Component <> Nil then OwnerName := Body.Component.Name.Text;
                Model := Body.Model;
                if Model = Nil then Report.Add('body|' + OwnerName + '|no model')
                else Report.Add('body|' + OwnerName + '|' + IntToStr(Model.ModelType) + '|' +
                                ExtractFileName(Model.FileName) + '|' + IntToStr(Model.GetDataSize) + '|' +
                                BoolToStr(Model.Embed, True) + '|' + IntToStr(Body.OverallHeight));
            end;
            Item := Objects.NextPCBObject;
        end;
        Report.Add('count|' + LabelText + '|' + IntToStr(Total));
    finally
        Board.BoardIterator_Destroy(Objects);
    end;
end;

procedure SurveyBoard(Board : IPCB_Board; Report : TStringList);
var
    Outline : IPCB_BoardOutline;
    Segment : TPolySegment;
    I : Integer;
begin
    Outline := Board.BoardOutline;
    for I := 0 to Outline.PointCount - 1 do
    begin
        Segment := Outline.Segments[I];
        if Segment.Kind = ePolySegmentLine then
            Report.Add('edge|line|' + IntToStr(Segment.vx) + '|' + IntToStr(Segment.vy))
        else
            Report.Add('edge|arc|' + IntToStr(Segment.vx) + '|' + IntToStr(Segment.vy) + '|' +
                       IntToStr(Segment.cx) + '|' + IntToStr(Segment.cy) + '|' +
                       IntToStr(Segment.Radius) + '|' + FloatToStr(Segment.Angle1) + '|' + FloatToStr(Segment.Angle2));
    end;
    InspectKind(Board, eComponentObject, 'components', Report);
    InspectKind(Board, ePadObject, 'pads', Report);
    InspectKind(Board, eViaObject, 'vias', Report);
    InspectKind(Board, eTrackObject, 'tracks', Report);
    InspectKind(Board, eArcObject, 'arcs', Report);
    InspectKind(Board, eTextObject, 'texts', Report);
    InspectKind(Board, ePolyObject, 'polygons', Report);
    InspectKind(Board, eRegionObject, 'regions', Report);
    InspectKind(Board, eComponentBodyObject, 'bodies', Report);
    InspectKind(Board, eNetObject, 'nets', Report);
    InspectKind(Board, eRuleObject, 'rules', Report);
end;

procedure WriteActivePCBReport;
var
    Board : IPCB_Board;
    Dialog : TSaveDialog;
    Report : TStringList;
begin
    Board := PCBServer.GetCurrentPCBBoard;
    if Board = Nil then
    begin
        ShowMessage('Open the PCB to inspect, then run the report again.');
        Exit;
    end;
    Dialog := TSaveDialog.Create(Nil);
    Report := TStringList.Create;
    try
        Dialog.Title := 'Save PCB inspection report';
        Dialog.Filter := 'Text report (*.txt)|*.txt';
        Dialog.DefaultExt := 'txt';
        Dialog.FileName := 'PCB inspection.txt';
        if Dialog.Execute then
        begin
            if FileExists(Dialog.FileName) then ShowMessage('Choose a new filename for the inspection report.')
            else
            begin
                SurveyBoard(Board, Report);
                Report.SaveToFile(Dialog.FileName);
            end;
        end;
    finally
        Report.Free;
        Dialog.Free;
    end;
end;
