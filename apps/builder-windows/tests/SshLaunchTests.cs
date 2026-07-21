using Xunit;
using Flagship.Builder.VM;

namespace Flagship.Builder.Tests;

public class SshLaunchTests
{
    [Fact]
    public void SshArgsTargetTheLoopbackForwardAsTheDebugUser()
    {
        var args = SshLaunch.SshArgs(2222);
        Assert.Equal(new[]
        {
            "-p", "2222",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=NUL",
            "debug@127.0.0.1",
        }, args);
    }

    [Fact]
    public void CmdKArgumentsWrapSshForANewConsoleWindow()
    {
        var cmd = SshLaunch.CmdKArguments(49712);
        Assert.StartsWith("/k ssh ", cmd);
        Assert.Contains("-p 49712", cmd);
        Assert.Contains("debug@127.0.0.1", cmd);
        Assert.Contains("StrictHostKeyChecking=no", cmd);
    }
}
