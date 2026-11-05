using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);

// האזנה לכל כרטיסי הרשת בפורט 5050 כדי שתלמידים בטלפון יוכלו להתחבר דרך ה-QR
builder.WebHost.UseUrls("http://0.0.0.0:5050");

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader();
    });
});

var app = builder.Build();
app.UseCors();

// זיהוי אוטומטי של כתובת ה-IP המקומית (למשל 192.168.1.9) עבור ה-QR Code
string GetLocalLanIp()
{
    try
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, 0);
        socket.Connect("8.8.8.8", 65530);
        if (socket.LocalEndPoint is IPEndPoint endPoint)
        {
            return endPoint.Address.ToString();
        }
    }
    catch { }

    try
    {
        var host = Dns.GetHostEntry(Dns.GetHostName());
        foreach (var ip in host.AddressList)
        {
            if (ip.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(ip))
            {
                return ip.ToString();
            }
        }
    }
    catch { }

    return "192.168.1.9";
}

var lanIp = GetLocalLanIp();
const int serverPort = 5050;

// הגשת קובצי ה-Web App ישירות מתיקיית הפרויקט
var fileProvider = new PhysicalFileProvider(builder.Environment.ContentRootPath);
app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider });

// זיכרון חדרים לסנכרון כיתתי בזמן אמת בין מורה לתלמידים
var roomStates = new ConcurrentDictionary<string, JsonElement>();
var studentEventQueues = new ConcurrentDictionary<string, ConcurrentQueue<JsonElement>>();

app.MapGet("/api/room/ping", () => Results.Ok(new
{
    ok = true,
    lanIp,
    port = serverPort,
    lanUrl = $"http://{lanIp}:{serverPort}"
}));

app.MapPost("/api/room/sync", async (HttpRequest req) =>
{
    var doc = await JsonDocument.ParseAsync(req.Body);
    var root = doc.RootElement.Clone();
    if (root.TryGetProperty("roomCode", out var codeProp))
    {
        var room = (codeProp.GetString() ?? "3H3T").ToUpperInvariant();
        roomStates[room] = root;
    }
    return Results.Ok(new { synced = true });
});

app.MapPost("/api/room/student-event", async (HttpRequest req) =>
{
    var doc = await JsonDocument.ParseAsync(req.Body);
    var root = doc.RootElement.Clone();
    if (root.TryGetProperty("roomCode", out var codeProp))
    {
        var room = (codeProp.GetString() ?? "3H3T").ToUpperInvariant();
        var q = studentEventQueues.GetOrAdd(room, _ => new ConcurrentQueue<JsonElement>());
        q.Enqueue(root);
    }
    return Results.Ok(new { queued = true });
});

app.MapGet("/api/room/poll", (string room = "3H3T", string role = "student") =>
{
    room = room.ToUpperInvariant();
    var messages = new List<JsonElement>();
    if (role == "teacher")
    {
        if (studentEventQueues.TryGetValue(room, out var q))
        {
            while (q.TryDequeue(out var evt))
            {
                messages.Add(evt);
            }
        }
    }
    else
    {
        if (roomStates.TryGetValue(room, out var state))
        {
            messages.Add(state);
        }
    }
    return Results.Ok(new { messages });
});

app.Run();
