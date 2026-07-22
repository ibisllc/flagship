using Xunit;

namespace Flagship.Builder.Tests;

public sealed class QrTerminalMatrixTests
{
    [Fact]
    public void Parse_StripsAnsiAndExpandsHalfBlocks()
    {
        var matrix = QrTerminalMatrix.Parse("\u001b[47m\u001b[30m █▀▄ \u001b[0m\n");

        Assert.Equal(2, matrix.GetLength(0));
        Assert.Equal(5, matrix.GetLength(1));
        Assert.True(matrix[0, 1]);
        Assert.True(matrix[1, 1]);
        Assert.True(matrix[0, 2]);
        Assert.False(matrix[1, 2]);
        Assert.False(matrix[0, 3]);
        Assert.True(matrix[1, 3]);
    }
}