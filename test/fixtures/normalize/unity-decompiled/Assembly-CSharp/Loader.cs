using BepInEx;

namespace Fixture
{
    namespace Plugins
    {
        [BepInPlugin("fixture.loader", "Loader", "1.0.0")]
        public class Loader : BaseUnityPlugin
        {
            private void Awake()
            {
                var player = Fixture.Game.Player.Create();
                Game.Stats stats = default;
            }
        }
    }
}
