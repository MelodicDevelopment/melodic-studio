namespace Fixture;

public class Greeter
{
    /// <summary>Builds the line the fixture prints.</summary>
    public string Greet(string name)
    {
        return $"Hello, {name}!";
    }
}
